import { deployContract } from 'ethereum-waffle'
import MockYieldService from '../build/MockYieldService.json'
import SponsorshipFactory from '../build/SponsorshipFactory.json'
import ControlledTokenFactory from '../build/ControlledTokenFactory.json'
import TicketFactory from '../build/TicketFactory.json'
import LoyaltyFactory from '../build/LoyaltyFactory.json'
import RNGBlockhash from '../build/RNGBlockhash.json'
import MockPrizeStrategy from '../build/MockPrizeStrategy.json'
import PeriodicPrizePool from '../build/PeriodicPrizePool.json'
import ERC20Mintable from '../build/ERC20Mintable.json'
import Forwarder from '../build/Forwarder.json'
import { deploy1820 } from 'deploy-eip-1820'
import { expect } from 'chai'
import { ethers } from './helpers/ethers'
import { increaseTime } from './helpers/increaseTime'
import buidler from './helpers/buidler'

const toWei = ethers.utils.parseEther

const debug = require('debug')('ptv3:PeriodicPrizePool.test')

async function prizePoolCurrentPrize(prizePoolContract: any) {
  let fxn = prizePoolContract.interface.functions.currentPrize
  let data = fxn.encode([])
  let result = await prizePoolContract.provider.call({ to: prizePoolContract.address, data })
  return fxn.decode(result)[0]
}

async function prizePoolEstimatePrize(prizePoolContract: any, secondsPerBlock: any) {
  let fxn = prizePoolContract.interface.functions.estimatePrize
  let data = fxn.encode([secondsPerBlock])
  let result = await prizePoolContract.provider.call({ to: prizePoolContract.address, data })
  return fxn.decode(result)[0]
}

async function getEvents(contract: any, txHash: any) {
  let provider = contract.provider
  let tx = await provider.getTransactionReceipt(txHash)
  let filter = { blockHash: tx.blockHash }
  let logs = await provider.getLogs(filter)
  let parsedLogs = logs.map((log: any) => contract.interface.parseLog(log))
  return parsedLogs
}

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe('PeriodicPrizePool contract', () => {
  
  let prizePool: any
  let token: any
  let ticket: any
  let sponsorship: any
  let timelock: any
  let mockYieldService: any
  let mockPrizeStrategy: any
  let rng: any
  let forwarder: any

  let wallet: any
  let allocator: any
  let otherWallet: any

  let startTime: any

  let prizePeriodSeconds: any

  const overrides = { gasLimit: 20000000 }

  beforeEach(async () => {
    [wallet, allocator, otherWallet] = await buidler.ethers.getSigners()

    ethers.errors.setLogLevel('error')

    await deploy1820(wallet)

    rng = await deployContract(wallet, RNGBlockhash, [])

    forwarder = await deployContract(wallet, Forwarder, [])
    prizePool = await deployContract(wallet, PeriodicPrizePool, [], overrides)
    await prizePool.construct()
    token = await deployContract(wallet, ERC20Mintable, [], overrides)
    debug('Deploying MockPrizeStrategy...')
    mockPrizeStrategy = await deployContract(wallet, MockPrizeStrategy, [], overrides)
    await mockPrizeStrategy.initialize()
    mockYieldService = await deployContract(wallet, MockYieldService, [], overrides)

    debug('ControlledTokenFactory...')

    let controlledTokenFactory = await deployContract(wallet, ControlledTokenFactory, [], overrides)
    await controlledTokenFactory.initialize()

    debug('TicketFactory...')

    let ticketFactory = await deployContract(wallet, TicketFactory, [], overrides)
    await ticketFactory.initialize(controlledTokenFactory.address)

    prizePeriodSeconds = 10

    debug('Deploying Ticket...')

    let tx = await ticketFactory['createTicket(string,string,address,address)'](
      'Ticket',
      'TICK',
      prizePool.address,
      forwarder.address
    )
    let logs = await getEvents(ticketFactory, tx.hash)
    debug({ logs })

    ticket = await buidler.ethers.getContractAt('Ticket', logs[1].values.ticket, wallet)

    debug('Deploying Loyalty...')

    let loyaltyFactory = await deployContract(wallet, LoyaltyFactory, [])
    await loyaltyFactory.initialize()

    debug('Deploying Sponsorship...')

    let sponsorshipFactory = await deployContract(wallet, SponsorshipFactory, [])
    await sponsorshipFactory.initialize(loyaltyFactory.address)
    tx = await sponsorshipFactory['createSponsorship(string,string,address,address)'](
      'Ticket',
      'TICK',
      prizePool.address,
      forwarder.address
    )
    logs = await getEvents(sponsorshipFactory, tx.hash)
    debug({ logs })

    sponsorship = await buidler.ethers.getContractAt('Sponsorship', logs[1].values.sponsorship, wallet)

    debug('Deploying MockYieldService...')

    await mockYieldService.initialize(
      token.address
    )
    await mockYieldService.setManager(prizePool.address)


    debug({
      forwarder: forwarder.address,
      sponsorship: sponsorship.address,
      ticket: ticket.address,
      mockYieldService: mockYieldService.address,
      mockPrizeStrategy: mockPrizeStrategy.address,
      rng: rng.address
    })

    debug('Enabling yield service module...')

    await prizePool.enableModule(mockYieldService.address)

    debug('Initializing PeriodicPrizePool...')

    tx = await prizePool['initialize(address,address,address,address,address,uint256)'](
      forwarder.address,
      sponsorship.address,
      ticket.address,
      mockPrizeStrategy.address,
      rng.address,
      prizePeriodSeconds
    )
    let block = await buidler.ethers.provider.getBlock(tx.blockHash)
    startTime = block.timestamp
    await token.mint(wallet._address, ethers.utils.parseEther('100000'))
    
    timelock = await buidler.ethers.getContractAt('ControlledToken', (await ticket.timelock()), wallet)
  })

  describe('initialize()', () => {
    it('should set all the vars', async () => {
      expect(await prizePool.ticket()).to.equal(ticket.address)
      expect(await prizePool.yieldService()).to.equal(mockYieldService.address)
      expect(await prizePool.prizeStrategy()).to.equal(mockPrizeStrategy.address)
      expect(await prizePool.currentPrizeStartedAt()).to.equal(startTime)
    })
  })

  describe('currentPrize()', () => {
    it('should return the available interest from the prize pool', async () => {
      await mockYieldService.setBalanceOf(toWei('100'))
      expect(await prizePoolCurrentPrize(prizePool)).to.equal(toWei('100'))
    })
  })

  describe('mintTickets()', () => {
    it('should create tickets', async () => {
      await token.approve(ticket.address, toWei('10'))

      expect(await token.balanceOf(prizePool.address)).to.equal(toWei('0'))

      debug('minting ticket...')

      await ticket.mintTickets(toWei('10'))

      debug('checking token balance')

      // underlying assets were moved to yieldService
      expect(await token.balanceOf(mockYieldService.address)).to.equal(toWei('10'))
      
      debug('checking ticket balance')

      // ticket pool minted tickets for the depositor
      expect(await ticket.balanceOf(wallet._address)).to.equal(toWei('10'))
    })
  })

  describe('redeemTicketsInstantly()', () => {
    it('should allow a user to pay to redeem their tickets', async () => {
      debug(`minting tickets...`)

      await token.approve(ticket.address, toWei('10'))
      await ticket.mintTickets(toWei('10'))

      let userBalance = await token.balanceOf(wallet._address)

      // prize of 10
      await mockYieldService.setBalanceOf(toWei('20'))

      await increaseTime(prizePeriodSeconds)

      debug(`starting award process...`)

      await prizePool.startAward()
      await prizePool.completeAward()

      debug(`checking previous prize...`)
    
      expect(await prizePool.previousPrize()).to.equal(toWei('10'))

      await increaseTime(4)

      await ticket.redeemTicketsInstantly(toWei('10'))

      // tickets are burned
      expect(await ticket.totalSupply()).to.equal(toWei('0'))

      // user receives tokens less fee
      let fee = (await token.balanceOf(wallet._address)).sub(userBalance)
      
      // depending on timestamps, fee will be 5 or 6
      debug(`Fee is ${ethers.utils.formatEther(fee)}`)
      expect(fee.eq(toWei('4')) || fee.eq(toWei('6')) || fee.eq(toWei('5'))).to.be.true
    })
  })

  describe('redeemTicketsWithTimelock()', () => {
    it('should lock the users funds', async () => {
      debug('minting tickets...')
      await token.approve(ticket.address, toWei('10'))
      await ticket.mintTickets(toWei('10'))

      let startedAt = await prizePool.currentPrizeStartedAt()
      const unlockTimestamp = startedAt.toNumber() + 10

      debug('redeem tickets with timelock...')

      await ticket.redeemTicketsWithTimelock(toWei('10'))

      // Tickets are burned
      expect(await ticket.balanceOf(wallet._address)).to.equal('0')
      
      debug('check timelock...')

      // Locked balance is recorded
      expect(await timelock.balanceOf(wallet._address)).to.equal(toWei('10'))
      expect(await ticket.timelockBalanceAvailableAt(wallet._address)).to.equal(unlockTimestamp)
    })

    it('should instantly redeem funds if unlockBlock is now or in the past', async () => {
      await token.approve(ticket.address, toWei('10'))
      let tx = await ticket.mintTickets(toWei('10'))

      // way beyond prize end
      await increaseTime(20)

      let userBalance = await token.balanceOf(wallet._address)
      tx = await ticket.redeemTicketsWithTimelock(toWei('4'))
      // Tickets are transferred
      expect((await token.balanceOf(wallet._address)).sub(userBalance)).to.equal(toWei('4'))
      expect(await timelock.balanceOf(wallet._address)).to.equal('0')
      expect(await ticket.timelockBalanceAvailableAt(wallet._address)).to.equal('0')
    })

    it('should sweep old locked deposits', async () => {
      // create tickets
      await token.approve(ticket.address, toWei('10'))
      await ticket.mintTickets(toWei('10'))

      // mark balance less tickets
      let userBalance = await token.balanceOf(wallet._address)

      // now redeem tickets
      await ticket.redeemTicketsWithTimelock(toWei('4'))

      // tickets should be burned
      expect(await ticket.balanceOf(wallet._address)).to.equal(toWei('6'))
    
      // now let's progress time so that the previous funds are unlocked
      await increaseTime(20)

      // redeem again
      await ticket.redeemTicketsWithTimelock(toWei('6'))

      // Remaining tickets are burned
      expect(await ticket.balanceOf(wallet._address)).to.equal(toWei('0'))

      // All tokens should have been transferred
      expect((await token.balanceOf(wallet._address)).sub(userBalance)).to.equal(toWei('10'))

      // Locked balance is recorded
      expect(await timelock.balanceOf(wallet._address)).to.equal(toWei('0'))
    })
  })

  describe('sweepTimelock()', () => {
    it('should return any timelocked funds that are now open', async () => {
      debug('minting tickets...')
      // deposit
      await token.approve(ticket.address, toWei('4'))
      await ticket.mintTickets(toWei('4'))

      let userBalance = await token.balanceOf(wallet._address)

      debug('redeem with timelock...')

      await ticket.redeemTicketsWithTimelock(toWei('4'))

      expect(await ticket.timelockBalanceAvailableAt(wallet._address)).to.equal(startTime + 10)

      // now progress time
      await increaseTime(10)

      debug('sweeping funds...')

      await ticket.sweepTimelock([wallet._address])

      expect(await timelock.balanceOf(wallet._address)).to.equal(toWei('0'))      

      expect((await token.balanceOf(wallet._address)).sub(userBalance)).to.equal(toWei('4'))
    })
  })

  describe('multiplyByRemainingTimeFraction()', () => {
    it('should calculate as a fraction of the time remaining', async () => {
      let remainingSeconds = (await prizePool.remainingSecondsToPrize()).toNumber()

      expect(await prizePool.multiplyByRemainingTimeFraction(toWei('1'))).to.equal(toWei('' + (remainingSeconds / prizePeriodSeconds)))

      // increment 4
      await increaseTime(4)

      remainingSeconds = (await prizePool.remainingSecondsToPrize()).toNumber()
      
      expect(await prizePool.multiplyByRemainingTimeFraction(toWei('1'))).to.equal(toWei('' + (remainingSeconds / prizePeriodSeconds)))
    })
  })

  describe('prizePeriodEndAt()', () => {
    it('should be correct', async () => {
      let start = (await prizePool.currentPrizeStartedAt()).toNumber()
      expect(await prizePool.prizePeriodEndAt()).to.equal(start + 10)
    })
  })

  describe('calculateExitFee(address, uint256 tickets)', () => {
    it('should calculate', async () => {
      // ensure there is interest
      await mockYieldService.setBalanceOf(toWei('11'))
      
      // create tickets
      await token.approve(ticket.address, toWei('10'))
      await ticket.mintTickets(toWei('10'))
      
      debug('increasing time...')

      await increaseTime(11)

      // award the prize.  will be 1 new ticket
      await prizePool.startAward()
      await prizePool.completeAward()

      debug('checking total sponsorship supply...')

      // Should be all of the tickets, plus the winnings
      expect(await sponsorship.totalSupply()).to.equal(toWei('11'))

      debug('calculating exit fee...')

      // now post-prize we want to check the fee.  Note that there are still only 10 tickets
      let exitFee = await ticket.calculateExitFee(wallet._address, toWei('10'))
      
      debug('calculating seconds...')

      let remainingSeconds = (await prizePool.remainingSecondsToPrize()).toNumber()
      let secs = (remainingSeconds / (prizePeriodSeconds*1.0))

      debug({ remainingSeconds, secs })

      // console.log({secs})
      expect(exitFee).to.equal(toWei('' + secs))
    })
  })

  describe('calculateUnlockTimestamp(address, uint256)', () => {
    it('should calculate the prize period end', async () => {
      let start = (await prizePool.currentPrizeStartedAt()).toNumber()
      expect(await prizePool.calculateUnlockTimestamp(wallet._address, '0')).to.equal(start + 10)
    })
  })

  describe('estimatePrize()', () => {
    it('should calculate the prize', async () => {
      await mockYieldService.setBalanceOf(toWei('1'))
      await token.approve(mockYieldService.address, toWei('10'))
      await mockYieldService.supply(toWei('10'))
      // should be current prize + estimated remaining
      expect(await prizePoolEstimatePrize(prizePool, '1')).to.equal('1000000000000000045')
    })
  })

  describe('estimateRemainingPrize()', () => {
    it('should estimate the remaining prize', async () => {
      expect(await prizePool.estimateRemainingPrize()).to.equal('45')
    })
  })

  describe('estimateRemainingPrizeWithBlockTime(uint256)', () => { 
    it('should estimate the prize given the seconds per block', async () => {
      expect(await prizePool.estimateRemainingPrizeWithBlockTime(toWei('10'))).to.equal('45')
    })
  })

  describe('startAward()', () => {
    it('should not be called before the prize period is over', async () => {
      await expect(prizePool.startAward()).to.be.revertedWith('prize period not over')
    })

    it('should succeed without a winner', async () => {
      await increaseTime(11)
      await prizePool.startAward()
      await prizePool.completeAward()
      let block = await buidler.ethers.provider.getBlock('latest')
      // new prize period end block
      expect(await prizePool.prizePeriodEndAt()).to.equal(block.timestamp + 10)
    })

    it('should draw a winner and allocate prize', async () => {
      // ensure the wallet can be selected by depositing
      await token.approve(ticket.address, toWei('10'))
      await ticket.mintTickets(toWei('10'))

      await mockYieldService.setBalanceOf(toWei('20'))

      await increaseTime(11)
      await prizePool.startAward()
      await prizePool.completeAward()
      let block = await buidler.ethers.provider.getBlock('latest')

      expect(await ticket.balanceOf(wallet._address)).to.equal(toWei('10'))
      
      // Ensure winnings have been minted as sponsorship
      expect(await sponsorship.balanceOf(prizePool.address)).to.equal(toWei('10'))
      // Ensure allowance has been made for strategy
      expect(await sponsorship.allowance(prizePool.address, mockPrizeStrategy.address)).to.equal(toWei('10'))

      // new prize period end block
      expect(await prizePool.prizePeriodEndAt()).to.equal(block.timestamp + 10)
    })
  })
})
