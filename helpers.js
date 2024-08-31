const { ethers } = require("ethers")
const Big = require('big.js')
const IUniswapV2Pair = require("@uniswap/v2-core/build/IUniswapV2Pair.json")
const IERC20 = require('@openzeppelin/contracts/build/contracts/ERC20.json')

// Convert human-readable value to smallest unit
function parseUnits(value, decimals = 18) {
  return BigInt(Big(value).times(Big(10).pow(decimals)).toFixed(0));
}

// Convert smallest unit value to human-readable
function formatUnits(value, decimals = 18) {
  return Big(value.toString()).div(Big(10).pow(decimals)).toString();
}

async function getTokenAndContract(_token0Address, _token1Address, _provider) {
  console.log(`Attempting to get token contracts for addresses: ${_token0Address}, ${_token1Address}`);
  
  const token0Contract = new ethers.Contract(_token0Address, IERC20.abi, _provider);
  const token1Contract = new ethers.Contract(_token1Address, IERC20.abi, _provider);

  const token0 = {
    address: _token0Address,
    decimals: 18,
    symbol: await token0Contract.symbol(),
    name: await token0Contract.name()
  };

  console.log(`Token 0 details successfully retrieved:`, token0);

  const token1 = {
    address: _token1Address,
    decimals: 18,
    symbol: await token1Contract.symbol(),
    name: await token1Contract.name()
  };

  console.log(`Token 1 details successfully retrieved:`, token1);

  return { token0Contract, token1Contract, token0, token1 };
}

async function getPairAddress(_V2Factory, _token0, _token1) {
  console.log(`Attempting to get pair address for tokens: ${_token0}, ${_token1}`);

  try {
    const pairAddress = await _V2Factory.getPair(_token0, _token1);
    return pairAddress;
  } catch (error) {
    console.error('Error getting pair address:', error);
    throw error;
  }
}

async function getPairContract(_V2Factory, _token0, _token1, _provider) {
  console.log(`Attempting to get pair contract for tokens: ${_token0}, ${_token1}`);

  try {
    const pairAddress = await getPairAddress(_V2Factory, _token0, _token1);
    const pairContract = new ethers.Contract(pairAddress, IUniswapV2Pair.abi, _provider);

    console.log(`Pair contract successfully created for address: ${pairAddress}`);

    return pairContract;
  } catch (error) {
    console.error(`Failed to get pair contract for tokens: ${_token0}, ${_token1}`, error);
    throw error;
  }
}

async function getReserves(_pairContract) {
  try {
    const reserves = await _pairContract.getReserves();
    return [reserves.reserve0, reserves.reserve1];
  } catch (error) {
    console.error(`There was a problem getting the reserves:`, error);
    return null;
  }
}

async function checkLiquidity(_pairContract, _tokenAddress, _amountIn) {
  console.log(`Attempting to check liquidity for token address: ${_tokenAddress} with amount in: ${_amountIn.toString()}`);

  try {
    const reserves = await getReserves(_pairContract);

    if (reserves === null) {
      console.error(`Failed to get reserves for liquidity check.`);
      return false;
    }

    const [reserve0, reserve1] = reserves;
    const reserve = _tokenAddress === _pairContract.token0 ? reserve0 : reserve1;

    console.log(`Liquidity check: Reserve=${reserve.toString()}, Amount In=${_amountIn.toString()}`);

    if (Big(reserve.toString()).lt(Big(_amountIn.toString()))) {
      console.error(`Insufficient liquidity: ${reserve.toString()} available, ${_amountIn.toString()} required.`);
      return false;
    }

    console.log(`Sufficient liquidity available.`);
    return true;
  } catch (error) {
    console.error(`Failed to check liquidity for token address: ${_tokenAddress}`, error);
    throw error;
  }
}

async function calculatePrice(_pairContract) {
  console.log(`Attempting to calculate price for pair contract at address: ${_pairContract.address}`);

  try {
    const [reserve0, reserve1] = await getReserves(_pairContract);
    const price = Big(reserve0.toString()).div(Big(reserve1.toString()));
    console.log(`Price successfully calculated: ${price.toString()}`);

    return price;
  } catch (error) {
    console.error(`Failed to calculate price for pair contract at address: ${_pairContract.address}`, error);
    throw error;
  }
}

async function calculateDifference(_uPrice, _sPrice) {
  console.log(`Attempting to calculate price difference: Uniswap Price=${_uPrice}, Sushiswap Price=${_sPrice}`);

  try {
    const difference = (((Big(_uPrice).minus(Big(_sPrice))).div(Big(_sPrice))).times(100)).toFixed(2);
    console.log(`Price difference successfully calculated: ${difference}%`);

    return difference;
  } catch (error) {
    console.error(`Failed to calculate price difference`, error);
    throw error;
  }
}

async function simulate(_amount, _routerPath, _token0, _token1) {
  console.log(`Attempting to simulate trade with amount: ${_amount} from ${_token0.symbol} to ${_token1.symbol}`);

  try {
    const trade1 = await _routerPath[0].getAmountsOut(_amount, [_token0.address, _token1.address]);
    const trade2 = await _routerPath[1].getAmountsOut(trade1[1], [_token1.address, _token0.address]);

    const amountIn = formatUnits(trade1[0], 18);
    const amountOut = formatUnits(trade2[1], 18);

    console.log(`Simulation successful: Amount In=${amountIn}, Amount Out=${amountOut}`);

    return { amountIn, amountOut };
  } catch (error) {
    console.error(`Failed to simulate trade from ${_token0.symbol} to ${_token1.symbol}`, error);
    throw error;
  }
}

function applySlippageTolerance(amount) {
  const slippageTolerance = 0.5; // Hardcoded slippage tolerance in percentage
  console.log(`Attempting to apply slippage tolerance: ${slippageTolerance}% to amount: ${amount}`);

  try {
    const slippageAmount = Big(amount).times(Big(slippageTolerance).div(100));
    const adjustedAmount = Big(amount).minus(slippageAmount);

    console.log(`Amount after slippage tolerance applied: ${adjustedAmount.toString()}`);
    return adjustedAmount;
  } catch (error) {
    console.error(`Failed to apply slippage tolerance`, error);
    throw error;
  }
}

async function calculateProfit(amountIn, amountOut, gasLimit, gasPrice) {
  console.log(`Attempting to calculate profit: Amount In=${amountIn}, Amount Out=${amountOut}`);

  try {
    // Convert gas price to ETH manually
    const gasPriceEth = formatUnits(gasPrice, 18);
    const estimatedGasCost = Big(gasLimit).times(Big(gasPriceEth));
    const profitBeforeGas = Big(amountOut).minus(Big(amountIn));
    const profit = profitBeforeGas.minus(estimatedGasCost);

    console.log(`Profit successfully calculated: ${profit.toString()} ETH`);
    return profit;
  } catch (error) {
    console.error(`Failed to calculate profit`, error);
    throw error;
  }
}

function isProfitAboveThreshold(profit, threshold) {
  console.log(`Checking if profit: ${profit.toString()} is above threshold: ${threshold}`);

  try {
    const isAboveThreshold = Big(profit).gte(Big(threshold));
    console.log(`Is profit above threshold? ${isAboveThreshold}`);

    return isAboveThreshold;
  } catch (error) {
    console.error(`Failed to check if profit is above threshold`, error);
    throw error;
  }
}

module.exports = {
  getTokenAndContract,
  getPairAddress,
  getPairContract,
  getReserves,
  checkLiquidity,
  calculatePrice,
  calculateDifference,
  simulate,
  applySlippageTolerance,
  calculateProfit,
  isProfitAboveThreshold
};
