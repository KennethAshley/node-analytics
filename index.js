const thorify = require("thorify").thorify;
const _ = require('lodash');
const Web3 = require("web3");
const ethers = require('ethers').ethers;
const async = require("async");

const config = require('./config');

const web3 = thorify(new Web3(), "http://localhost:8669");

const vexchangeFactory = new web3.eth.Contract(
  config.FACTORY_ABI,
  config.FACTORY_ADDRESS,
);

class RoiInfo {
  constructor(dmChange, vetBalance, tokenBalance, tradeVolume) {
    this.dmChange = dmChange;
    this.vetBalance = vetBalance;
    this.tokenBalance = tokenBalance;
    this.tradeVolume = tradeVolume;
  }
}

const handler = {
  get: function(target, name) {
    return target.hasOwnProperty(name) ? target[name] : 0;
  }
};
    
(async () => { const { number: CURRENT_BLOCK } = await web3.eth.getBlock("latest");

  const loadExchangeData = async ([tokenAddress, exchangeAddress]) => {
    const token = new web3.eth.Contract(
      config.STR_ERC_20_ABI,
      tokenAddress,
    );

    const name = await token.methods.name().call();
    const symbol = await token.methods.symbol().call();
    const decimals = await token.methods.decimals().call();
    const balance = await token.methods.balanceOf(exchangeAddress).call(null, CURRENT_BLOCK);
    const vetBalance = await web3.eth.getBalance(exchangeAddress, CURRENT_BLOCK);
    const exchange = new web3.eth.Contract(config.EXCHANGE_ABI, exchangeAddress);
    const swapFee = await exchange.methods.swap_fee().call();
    const platformFee = await exchange.methods.platform_fee().call();

    return {
      balance,
      decimals,
      exchange,
      exchangeAddress,
      name,
      platformFee,
      swapFee,
      symbol,
      tokenAddress,
      vetBalance,
    }
  };

  const loadExchangeInfos = async (infos) => {
    // get token count
    const tokenCount = await vexchangeFactory.methods.tokenCount().call();

    // get token addresses
    const loadTokens = _.times(tokenCount, (i) => {
      return vexchangeFactory.methods.getTokenWithId(i + 1).call()
    });
    const tokens = await Promise.all(loadTokens);

    // get exchange addresses
    const loadExchanges = tokens.map(token => {
      return vexchangeFactory.methods.getExchange(token).call();
    });
    const exchanges = await Promise.all(loadExchanges);

    const loadNewInfos = _.zip(tokens, exchanges).map(item => {
      return loadExchangeData(item);
    });

    const newInfos = await Promise.all(loadNewInfos);

    return newInfos;
  };

  const wait = ms => {
    return new Promise(resolve => setTimeout(resolve, ms));
  };

  const getLogs = async (addresses, topics, startBlock) => {
    const getChunks = (start, address) => {
      return web3.eth.getPastLogs({
        fromBlock: start,
        toBlock: CURRENT_BLOCK,
        address: address,
        topics,
      })
    };

    const logs = addresses.map(async address => {
      return await getChunks(startBlock, address);
    });

    // these may be costly
    // look at performance
    return Promise.all(logs)
      .then(data => data.filter(item => item.length))
      .then(data => _.flatten(data))
      .then(data => _.groupBy(data, 'address'));
  };
  
  const loadLogs = async (startBlock, infos) => {
    const prefix = '0x000000000000000000000000';
    const exchangeAddresses = infos.map(info => info.exchangeAddress);
    const tokenAddresses = infos.map(info => info.tokenAddress);
    const exchangeLogs = await getLogs(exchangeAddresses, [config.ALL_EVENTS], startBlock);
    const exchangeTopics = exchangeAddresses.map(address => prefix + address.substring(2))
    const tokenLogs = await getLogs(tokenAddresses, [[config.EVENT_TRANSFER], [], exchangeTopics], startBlock)
    let logs1 = [];
    let logs2 = [];

    infos.forEach(info => {
      const newExchangeLogs = exchangeLogs[info.exchangeAddress.toLowerCase()];
      const newTokenLogs = tokenLogs[info.tokenAddress.toLowerCase()];

      if (newExchangeLogs?.length) {
        logs1.push(newExchangeLogs);
      }

      if (newTokenLogs?.length) {
        logs2.push(newTokenLogs);
      }
    });

    return _.flatten([...logs1, ...logs2]);
  };

  const getChartRange = (start = config.GENSIS_BLOCK_NUMBER) => {
    return _.range(start, CURRENT_BLOCK, config.HISTORY_CHUNK_SIZE);
  };

  const populateProviders = data => {
    return new Promise(resolve => {
      async.forEach(data.infos, async (info) => {
        const exchange = new web3.eth.Contract(config.EXCHANGE_ABI, info.exchangeAddress);

        const events = await exchange.getPastEvents('Transfer');

        async.forEach(events, event => {
          if (event.raw.topics[0] != config.EVENT_TRANSFER || event.address == info.exchangeAddress) {
            return;
          }

          if (event.returnValues['_from'] == ethers.constants.AddressZero) {
            let ether = ethers.utils.bigNumberify(event.returnValues['_value']);

            data.providers[event.returnValues['_to']] += parseInt(ethers.utils.formatEther(ether), 10)
          } else if (event.returnValues['_to'] == ethers.constants.AddressZero) {
            ether = ethers.utils.bigNumberify(event.returnValues['_value']);

            data.providers[event.returnValues['_from']] -= parseInt(ethers.utils.formatEther(ether), 10);
          } else {
            ether = ethers.utils.bigNumberify(event.returnValues['_value']);

            data.providers[event.returnValues['_from']] -= parseInt(ethers.utils.formatEther(ether), 10);
            data.providers[event.returnValues['_to']] += parseInt(ethers.utils.formatEther(ether), 10);
          }

        });
      }, () => {
        resolve(data.providers);
      });
    });
  };

  const populateRoi = data => {
    let dmNumerator = 1;
    let dmDenominator = 1;
    let tradeVolume = 0;
    let vetBalance = 0;
    let tokenBalance = 0;

    async.forEach(data.infos, async (info) => {
      const exchange = new web3.eth.Contract(config.EXCHANGE_ABI, info.exchangeAddress);
      const events = await exchange.getPastEvents('allEvents');

      async.forEach(events, event => {
        if (event.raw.topics[0] == config.EVENT_TRANSFER) {
          if (event.address == info.exchangeAddress) {
            return;
          } else {
            if (event.event == 'Transfer') {
              if (event.returnValues['_to'] != info.exchangeAddress) {
                return;
              }
            }

            if (tokenBalance > 0) {
              let value = ethers.utils.bigNumberify(event.returnValues._value);
              dmNumerator *= tokenBalance + parseInt(ether.utils.formatEther(value), 10);
              dmDenominator *= tokenBalance;
            }

            let value = ethers.utils.bigNumberify(event.returnValues._value);

            tokenBalance += parseInt(ethers.utils.bigNumberify(value));
          }
        } else if (event.raw.topics[0] == config.EVENT_ADD_LIQUIDITY) {
          let vBalance = ethers.utils.bigNumberify(event.returnValues['eth_amount']);
          let tBalance = ethers.utils.bigNumberify(event.returnValues['token_amount']);

          vetBalance += parseInt(ethers.utils.formatEther(vBalance), 10);
          tokenBalance += parseInt(ethers.utils.formatEther(tBalance), 10);
        } else if (event.raw.topics[0] == config.EVENT_REMOVE_LIQUIDITY) {
          let vBalance = ethers.utils.bigNumberify(event.returnValues['eth_amount']);
          let tBalance = ethers.utils.bigNumberify(event.returnValues['token_amount']);

          vetBalance -= parseInt(ethers.utils.formatEther(vBalance), 10);
          tokenBalance -= parseInt(ethers.utils.formatEther(tBalance), 10);
        } else if (event.raw.topics[0] == config.EVENT_ETH_PURCHASE) {
          let vetBought = ethers.utils.bigNumberify(event.returnValues.eth_bought);
          let tokenSold = ethers.utils.bigNumberify(event.returnValues.tokens_sold);

          let vetNewBalance = vetBalance + parseInt(ethers.utils.formatEther(vetBought), 10);
          let tokenNewBalance = tokenBalance + parseInt(ethers.utils.formatEther(tokenSold), 10);

          dmNumerator *= vetNewBalance * tokenNewBalance;
          dmDenominator *= parseInt(ethers.utils.formatEther(vetBought), 10) * tokenBalance;
          tradeVolume += parseInt(ethers.utils.formatEther(vetBought), 10) / 0.997;
          vetBought = vetNewBalance;
          tokenBalance = tokenNewBalance;
        } else {
          if (event.raw.topics[0] == config.EVENT_TOKEN_PURCHASE) {
            let vetSold = ethers.utils.bigNumberify(event.returnValues.eth_sold);
            let tokenBought = ethers.utils.bigNumberify(event.returnValues.tokens_bought);

            let vetNewBalance = vetBalance + parseInt(ethers.utils.formatEther(vetSold), 10);
            let tokenNewBalance = tokenBalance + parseInt(ethers.utils.formatEther(tokenBought), 10);

            dmNumerator *= vetNewBalance * tokenNewBalance;
            dmDenominator *= parseInt(ethers.utils.formatEther(vetSold), 10) * tokenBalance;
            tradeVolume += parseInt(ethers.utils.formatEther(vetSold), 10);
            vetBought = vetNewBalance;
            tokenBalance = tokenNewBalance;
          }
        }
      });
    }, () => {
      console.log(
        `trade volume: ${tradeVolume}`,
        `vet bought: ${vetBought}`
        `token balance: ${tokenBalance}`
      );
    });
  };

  const populateVolume = data => {
    let totalTradeVolume = new Proxy({}, handler);
    let volume = [];

    async.forEach(data.infos, async (info) => {
      const exchange = new web3.eth.Contract(config.EXCHANGE_ABI, info.exchangeAddress);
      const events = await exchange.getPastEvents('allEvents');

      let tradeVolume = new Proxy({}, handler);

      async.forEach(events, event => {
        if (event.raw.topics[0] == config.EVENT_ETH_PURCHASE) {
          let vetBought = ethers.utils.bigNumberify(event.returnValues.eth_bought);

          tradeVolume[event.returnValues.buyer] += parseInt(ethers.utils.formatEther(vetBought)) / 0.997;
          totalTradeVolume[event.returnValues.buyer] += parseInt(ethers.utils.formatEther(vetBought)) / 0.997;
        } else if (event.raw.topics[0] == config.EVENT_TOKEN_PURCHASE) {
          let vetSold = ethers.utils.bigNumberify(event.returnValues.eth_sold);

          tradeVolume[event.returnValues.buyer] += parseInt(ethers.utils.formatEther(vetSold));
          totalTradeVolume[event.returnValues.buyer] += parseInt(ethers.utils.formatEther(vetSold));
        }

        volume.push(tradeVolume);
      });

      let totalVolume = Object.values(totalTradeVolume).reduce((a, b) => a + b, 0);

      totalTradeVolume.forEach((t, v) => {
        console.log(v)
      });

      //volume.forEach(vol => {
      //  let filteredVol = new Proxy({}, handler);
      //  vol.forEach((t, v) => {
      //  });
      //});

    });
  };

  const main = async () => {
    // set default value in providers
    const data = {
      infos: [],
      logs: [],
      volume: [],
      providers: new Proxy({}, handler),
      roi: [],
      history: []
    };

    data.infos = await loadExchangeInfos(data.infos);
    data.logs = await loadLogs(config.GENSIS_BLOCK_NUMBER, data.infos);
    data.providers = await populateProviders(data);
    //await populateRoi(data);
    await populateVolume(data);
  }

  main();
})();
