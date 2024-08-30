// -- HANDLE INITIAL SETUP -- //
require('./helpers/server')
require("dotenv").config();

const ethers = require("ethers")
const config = require('./config.json')
const { 
  getTokenAndContract,
  getPairContract,
  getReserves,
  checkLiquidity,
  calculatePrice,
  calculateDifference,
  simulate,
  applySlippageTolerance,
  calculateProfit,
  isProfitAboveThreshold 
} = require('./helpers/helpers')

const { 
  provider, 
  uFactory, 
  uRouter, 
  sFactory, 
  sRouter, 
  arbitrage 
} = require('./helpers/initialization')

// -- .ENV VALUES HERE -- //
const arbFor = process.env.ARB_FOR 
const arbAgainst = process.env.ARB_AGAINST 
const units = process.env.UNITS
const difference = process.env.PRICE_DIFFERENCE
const gasLimit = process.env.GAS_LIMIT
const gasPrice = process.env.GAS_PRICE
const minProfitThreshold = process.env.MIN_PROFIT_THRESHOLD

let uPair, sPair, amount
let isExecuting = false

const main = async () => {
  const { token0Contract, token1Contract, token0, token1 } = await getTokenAndContract(arbFor, arbAgainst, provider)
  uPair = await getPairContract(uFactory, token0.address, token1.address, provider)
  sPair = await getPairContract(sFactory, token0.address, token1.address, provider)

  console.log(`uPair Address: ${await uPair.getAddress()}`)
  console.log(`sPair Address: ${await sPair.getAddress()}\n`)

  uPair.on('Swap', async () => {
    if (!isExecuting) {
      isExecuting = true

      const priceDifference = await checkPrice('Uniswap', token0, token1)
      const routerPath = await determineDirection(priceDifference)

      if (!routerPath) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const isProfitable = await determineProfitability(routerPath, token0Contract, token0, token1)

      if (!isProfitable) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const receipt = await executeTrade(routerPath, token0Contract, token1Contract)

      isExecuting = false
    }
  })

  sPair.on('Swap', async () => {
    if (!isExecuting) {
      isExecuting = true

      const priceDifference = await checkPrice('Sushiswap', token0, token1)
      const routerPath = await determineDirection(priceDifference)

      if (!routerPath) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const isProfitable = await determineProfitability(routerPath, token0Contract, token0, token1)

      if (!isProfitable) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const receipt = await executeTrade(routerPath, token0Contract, token1Contract)

      isExecuting = false
    }
  })

  console.log("Waiting for swap event...")
}

const checkPrice = async (_exchange, _token0, _token1) => {
  isExecuting = true

  console.log(`Swap Initiated on ${_exchange}, Checking Price...\n`)

  const currentBlock = await provider.getBlockNumber()

  const uPrice = await calculatePrice(uPair)
  const sPrice = await calculatePrice(sPair)

  const uFPrice = Number(uPrice).toFixed(units)
  const sFPrice = Number(sPrice).toFixed(units)
  const priceDifference = (((uFPrice - sFPrice) / sFPrice) * 100).toFixed(2)

  console.log(`Current Block: ${currentBlock}`)
  console.log(`-----------------------------------------`)
  console.log(`UNISWAP   | ${_token1.symbol}/${_token0.symbol}\t | ${uFPrice}`)
  console.log(`SUSHISWAP | ${_token1.symbol}/${_token0.symbol}\t | ${sFPrice}\n`)
  console.log(`Percentage Difference: ${priceDifference}%\n`)

  return priceDifference
}

const determineDirection = async (_priceDifference) => {
  console.log(`Determining Direction...\n`)

  if (_priceDifference >= difference) {

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t Uniswap`)
    console.log(`Sell\t -->\t Sushiswap\n`)
    return [uRouter, sRouter]

  } else if (_priceDifference <= -(difference)) {

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t Sushiswap`)
    console.log(`Sell\t -->\t Uniswap\n`)
    return [sRouter, uRouter]

  } else {
    return null
  }
}

const determineProfitability = async (_routerPath, _token0Contract, _token0, _token1) => {
  console.log(`Determining Profitability...\n`)

  let exchangeToBuy, exchangeToSell
  let pairToCheck

  if (await _routerPath[0].getAddress() === await uRouter.getAddress()) {
    exchangeToBuy = "Uniswap"
    exchangeToSell = "Sushiswap"
    pairToCheck = uPair
  } else {
    exchangeToBuy = "Sushiswap"
    exchangeToSell = "Uniswap"
    pairToCheck = sPair
  }

  const uReserves = await getReserves(uPair);
  const sReserves = await getReserves(sPair);

  // Find the smaller reserve between Uniswap and Sushiswap
  const minReserve = uReserves[0] < sReserves[0] ? uReserves[0] : sReserves[0];

  // Calculate minAmount as 3% of the smaller reserve
  const tradePercentage = 3; // Adjust this percentage as needed
  let minAmount = BigInt(minReserve) * BigInt(tradePercentage) / BigInt(100);

  const liquidityCheck = await checkLiquidity(pairToCheck, _token0, minAmount);

  if (!liquidityCheck) {
    console.log(`Liquidity Check Failed.\n`);
    return false;
  }

  try {
    const estimate = await _routerPath[0].getAmountsIn(minAmount, [_token0.address, _token1.address])

    const result = await _routerPath[1].getAmountsOut(estimate[1], [_token1.address, _token0.address])

    console.log(`Estimated amount of WETH needed to buy enough Pepe on ${exchangeToBuy}\t\t| ${ethers.formatUnits(estimate[0], 'ether')}`)
    console.log(`Estimated amount of WETH returned after swapping Pepe on ${exchangeToSell}\t| ${ethers.formatUnits(result[1], 'ether')}\n`)

    const { amountIn, amountOut } = await simulate(estimate[0], minAmount, _routerPath, _token0, _token1)
    const amountDifference = amountOut - amountIn
    const estimatedGasCost = gasLimit * gasPrice
    const profit = await calculateProfit(amountIn, amountOut, gasLimit, gasPrice)

    const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

    const ethBalanceBefore = ethers.formatUnits(await provider.getBalance(account.address), 'ether')
    const ethBalanceAfter = ethBalanceBefore - estimatedGasCost

    const wethBalanceBefore = Number(ethers.formatUnits(await _token0Contract.balanceOf(account.address), 'ether'))
    const wethBalanceAfter = amountDifference + wethBalanceBefore
    const wethBalanceDifference = wethBalanceAfter - wethBalanceBefore

    const data = {
      'ETH Balance Before': ethBalanceBefore,
      'ETH Balance After': ethBalanceAfter,
      'ETH Spent (gas)': estimatedGasCost,
      '-': {},
      'WETH Balance BEFORE': wethBalanceBefore,
      'WETH Balance AFTER': wethBalanceAfter,
      'WETH Gained/Lost': wethBalanceDifference,
      '-': {},
      'Total Gained/Lost': wethBalanceDifference - estimatedGasCost
    }

    console.table(data)
    console.log()

    const profitAboveThreshold = await isProfitAboveThreshold(profit, minProfitThreshold)

    if (!profitAboveThreshold) {
      console.log(`Profit below threshold.\n`)
      return false
    }

    amount = applySlippageTolerance(amountIn, slippageTolerance)
    return true

  } catch (error) {
    console.log(error)
    console.log(`\nError occurred while trying to determine profitability...\n`)
    console.log(`This can typically happen because of liquidity issues, see README for more information.\n`)
    return false
  }
}

const executeTrade = async (_routerPath, _token0Contract, _token1Contract) => {
  console.log(`Attempting Arbitrage...\n`)

  let startOnUniswap

  if (await _routerPath[0].getAddress() == await uRouter.getAddress()) {
    startOnUniswap = true
  } else {
    startOnUniswap = false
  }

  // Create Signer
  const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

  // Fetch token balances before
  const tokenBalanceBefore = await _token0Contract.balanceOf(account.address)
  const ethBalanceBefore = await provider.getBalance(account.address)

  if (config.PROJECT_SETTINGS.isDeployed) {
    const transaction = await arbitrage.connect(account).executeTrade(
      startOnUniswap,
      await _token0Contract.getAddress(),
      await _token1Contract.getAddress(),
      amount,
      { gasLimit: process.env.GAS_LIMIT }
    )

    const receipt = await transaction.wait()
  }

  console.log(`Trade Complete:\n`)

  // Fetch token balances after
  const tokenBalanceAfter = await _token0Contract.balanceOf(account.address)
  const ethBalanceAfter = await provider.getBalance(account.address)

  const tokenBalanceDifference = tokenBalanceAfter - tokenBalanceBefore
  const ethBalanceDifference = ethBalanceBefore - ethBalanceAfter

  const data = {
    'ETH Balance Before': ethers.formatUnits(ethBalanceBefore, 'ether'),
    'ETH Balance After': ethers.formatUnits(ethBalanceAfter, 'ether'),
    'ETH Spent (gas)': ethers.formatUnits(ethBalanceDifference.toString(), 'ether'),
    '-': {},
    'WETH Balance BEFORE': ethers.formatUnits(tokenBalanceBefore, 'ether'),
    'WETH Balance AFTER': ethers.formatUnits(tokenBalanceAfter, 'ether'),
    'WETH Gained/Lost': ethers.formatUnits(tokenBalanceDifference.toString(), 'ether'),
    '-': {},
    'Total Gained/Lost': `${ethers.formatUnits((tokenBalanceDifference - ethBalanceDifference).toString(), 'ether')} ETH`
  }

  console.table(data)
}

main()
