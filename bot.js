// -- HANDLE INITIAL SETUP -- //
require('./helpers/server');
require("dotenv").config();

const { ethers } = require("ethers");
const Big = require('big.js');
const config = require('./config.json');
const { getTokenAndContract, getPairContract, getReserves, calculatePrice, simulate, applySlippageTolerance, calculateProfit, isProfitAboveThreshold } = require('./helpers/helpers');
const { provider, uFactory, uRouter, sFactory, sRouter, arbitrage } = require('./helpers/initialization');

// -- .ENV VALUES HERE -- //
const arbFor = process.env.ARB_FOR;
const arbAgainst = process.env.ARB_AGAINST;
const units = parseInt(process.env.UNITS, 10);
const difference = parseFloat(process.env.PRICE_DIFFERENCE);
const gasLimit = parseInt(process.env.GAS_LIMIT, 10);
const gasPrice = parseFloat(process.env.GAS_PRICE);

let uPair, sPair, amount;
let isExecuting = false;

const main = async () => {
  const { token0Contract, token1Contract, token0, token1 } = await getTokenAndContract(arbFor, arbAgainst, provider);
  uPair = await getPairContract(uFactory, token0.address, token1.address, provider);
  sPair = await getPairContract(sFactory, token0.address, token1.address, provider);

  console.log(`uPair Address: ${await uPair.getAddress()}`);
  console.log(`sPair Address: ${await sPair.getAddress()}\n`);

  uPair.on('Swap', async () => {
    if (!isExecuting) {
      isExecuting = true;

      const priceDifference = await checkPrice('Uniswap', token0, token1);
      const routerPath = await determineDirection(priceDifference);

      if (!routerPath) {
        console.log(`No Arbitrage Currently Available\n`);
        console.log(`-----------------------------------------\n`);
        isExecuting = false;
        return;
      }

      const isProfitable = await determineProfitability(routerPath, token0Contract, token0, token1);

      if (!isProfitable) {
        console.log(`No Arbitrage Currently Available\n`);
        console.log(`-----------------------------------------\n`);
        isExecuting = false;
        return;
      }

      const receipt = await executeTrade(routerPath, token0Contract, token1Contract);

      isExecuting = false;
    }
  });

  sPair.on('Swap', async () => {
    if (!isExecuting) {
      isExecuting = true;

      const priceDifference = await checkPrice('Sushiswap', token0, token1);
      const routerPath = await determineDirection(priceDifference);

      if (!routerPath) {
        console.log(`No Arbitrage Currently Available\n`);
        console.log(`-----------------------------------------\n`);
        isExecuting = false;
        return;
      }

      const isProfitable = await determineProfitability(routerPath, token0Contract, token0, token1);

      if (!isProfitable) {
        console.log(`No Arbitrage Currently Available\n`);
        console.log(`-----------------------------------------\n`);
        isExecuting = false;
        return;
      }

      const receipt = await executeTrade(routerPath, token0Contract, token1Contract);

      isExecuting = false;
    }
  });

  console.log("Waiting for swap event...");
};

const checkPrice = async (_exchange, _token0, _token1) => {
  isExecuting = true;

  console.log(`Swap Initiated on ${_exchange}, Checking Price...\n`);

  const currentBlock = await provider.getBlockNumber();

  const uPrice = await calculatePrice(uPair);
  const sPrice = await calculatePrice(sPair);

  const uFPrice = Big(uPrice).toFixed(units);
  const sFPrice = Big(sPrice).toFixed(units);
  const priceDifference = Big(uFPrice).minus(Big(sFPrice)).div(Big(sFPrice)).times(100).toFixed(2);

  console.log(`Current Block: ${currentBlock}`);
  console.log(`-----------------------------------------`);
  console.log(`UNISWAP   | ${_token1.symbol}/${_token0.symbol}\t | ${uFPrice}`);
  console.log(`SUSHISWAP | ${_token1.symbol}/${_token0.symbol}\t | ${sFPrice}\n`);
  console.log(`Percentage Difference: ${priceDifference}%\n`);

  return priceDifference;
};

const determineDirection = async (_priceDifference) => {
  console.log(`Determining Direction...\n`);

  if (parseFloat(_priceDifference) >= difference) {
    console.log(`Potential Arbitrage Direction:\n`);
    console.log(`Buy\t -->\t Uniswap`);
    console.log(`Sell\t -->\t Sushiswap\n`);
    return [uRouter, sRouter];
  } else if (parseFloat(_priceDifference) <= -difference) {
    console.log(`Potential Arbitrage Direction:\n`);
    console.log(`Buy\t -->\t Sushiswap`);
    console.log(`Sell\t -->\t Uniswap\n`);
    return [sRouter, uRouter];
  } else {
    return null;
  }
};

const determineProfitability = async (_routerPath, _token0Contract, _token0, _token1) => {
  console.log(`Determining Profitability...\n`);

  let exchangeToBuy, exchangeToSell;

  if (await _routerPath[0].getAddress() === await uRouter.getAddress()) {
    exchangeToBuy = "Uniswap";
    exchangeToSell = "Sushiswap";
  } else {
    exchangeToBuy = "Sushiswap";
    exchangeToSell = "Uniswap";
  }

  const uReserves = await getReserves(uPair);
  const sReserves = await getReserves(sPair);

  let minAmount;

  if (Big(uReserves[0]).gt(Big(sReserves[0]))) {
    minAmount = Big(sReserves[0]).div(2);
  } else {
    minAmount = Big(uReserves[0]).div(2);
  }

  try {
    const estimate = await _routerPath[0].getAmountsIn(minAmount.toString(), [_token0.address, _token1.address]);
    const result = await _routerPath[1].getAmountsOut(estimate[1], [_token1.address, _token0.address]);

    console.log(`Estimated amount of WETH needed to buy enough Shib on ${exchangeToBuy}\t\t| ${formatUnits(estimate[0], 18)}`);
    console.log(`Estimated amount of WETH returned after swapping SHIB on ${exchangeToSell}\t| ${formatUnits(result[1], 18)}\n`);

    const { amountIn, amountOut } = await simulate(estimate[0], _routerPath, _token0, _token1);
    const amountDifference = Big(amountOut).minus(Big(amountIn));
    const estimatedGasCost = Big(gasLimit).times(Big(gasPrice));

    const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const ethBalanceBefore = Big(await provider.getBalance(account.address).then(balance => formatUnits(balance, 18)));
    const ethBalanceAfter = ethBalanceBefore.minus(estimatedGasCost);

    const wethBalanceBefore = Big(await _token0Contract.balanceOf(account.address).then(balance => formatUnits(balance, 18)));
    const wethBalanceAfter = wethBalanceBefore.plus(amountDifference);
    const wethBalanceDifference = wethBalanceAfter.minus(wethBalanceBefore);

    const data = {
      'ETH Balance Before': ethBalanceBefore.toFixed(18),
      'ETH Balance After': ethBalanceAfter.toFixed(18),
      'ETH Spent (gas)': estimatedGasCost.toFixed(18),
      '-': {},
      'WETH Balance BEFORE': wethBalanceBefore.toFixed(18),
      'WETH Balance AFTER': wethBalanceAfter.toFixed(18),
      'WETH Gained/Lost': wethBalanceDifference.toFixed(18),
      '-': {},
      'Total Gained/Lost': wethBalanceDifference.minus(estimatedGasCost).toFixed(18)
    };

    console.table(data);
    console.log();

    if (Big(amountOut).lt(Big(amountIn))) {
      return false;
    }

    amount = parseUnits(amountIn, 18);
    return true;
  } catch (error) {
    console.log(error);
    console.log(`\nError occurred while trying to determine profitability...\n`);
    console.log(`This can typically happen because of liquidity issues, see README for more information.\n`);
    return false;
  }
};

const executeTrade = async (_routerPath, _token0Contract, _token1Contract) => {
  console.log(`Attempting Arbitrage...\n`);

  const startOnUniswap = await _routerPath[0].getAddress() === await uRouter.getAddress();

  const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  const tokenBalanceBefore = Big(await _token0Contract.balanceOf(account.address).then(balance => formatUnits(balance, 18)));
  const ethBalanceBefore = Big(await provider.getBalance(account.address).then(balance => formatUnits(balance, 18)));

  if (config.PROJECT_SETTINGS.isDeployed) {
    const transaction = await arbitrage.connect(account).executeTrade(
      startOnUniswap,
      await _token0Contract.getAddress(),
      await _token1Contract.getAddress(),
      amount,
      { gasLimit: gasLimit, gasPrice: ethers.utils.parseUnits(gasPrice.toString(), 'gwei') }
    );

    console.log(`Transaction Hash: ${transaction.hash}`);
    await transaction.wait();
    console.log(`Transaction confirmed!\n`);
  } else {
    console.log(`Deployment not confirmed in the config. Skipping transaction.\n`);
    return;
  }

  // Logging balances after trade
  const tokenBalanceAfter = Big(await _token0Contract.balanceOf(account.address).then(balance => formatUnits(balance, 18)));
  const ethBalanceAfter = Big(await provider.getBalance(account.address).then(balance => formatUnits(balance, 18)));

  console.log(`Token Balance Before: ${tokenBalanceBefore.toFixed(18)}`);
  console.log(`Token Balance After: ${tokenBalanceAfter.toFixed(18)}`);
  console.log(`ETH Balance Before: ${ethBalanceBefore.toFixed(18)}`);
  console.log(`ETH Balance After: ${ethBalanceAfter.toFixed(18)}\n`);
};

// Helper function for formatting units
const formatUnits = (value, decimals) => {
  return Big(value).div(Big(10).pow(decimals)).toFixed(decimals);
};

// Start the main process
main().catch(err => {
  console.error(`Error in main execution: ${err.message}`);
  process.exit(1);
});
