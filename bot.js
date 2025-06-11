require('dotenv').config();
const axios = require('axios');
const Binance = require('node-binance-api');
const { BINANCE_API_KEY, BINANCE_SECRET_KEY, SIMULATION } = process.env;

const binance = new Binance().options({
    APIKEY: BINANCE_API_KEY,
    APISECRET: BINANCE_SECRET_KEY,
    useServerTime: true,
    recvWindow: 5000,
});

global.binance = binance;
const isSimulation = SIMULATION === 'true';

const assetInfoCache = {};

async function getAssetInfo(symbol) {
    if (assetInfoCache[symbol]) return assetInfoCache[symbol];

    try {
        const { data: { symbols } } = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const symbolInfo = symbols.find(s => s.symbol === symbol);

        const notional = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL').notional;
        const info = {
            basePrecision: symbolInfo.baseAssetPrecision,
            quotePrecision: symbolInfo.quotePrecision,
            minNotional: Number(notional)
        };

        assetInfoCache[symbol] = info;
        return info;
    } catch (error) {
        console.error(`Asset info error for ${symbol}:`, error);
        throw error;
    }
}

async function getCurrentPrice(symbol) {
    try {
        const prices = await binance.futuresPrices();
        return parseFloat(prices[symbol]);
    } catch (error) {
        console.error(`Price fetch error for ${symbol}:`, error);
        throw error;
    }
}

function roundToPrecision(value, precision) {
    const factor = Math.pow(10, precision);
    return Math.floor(value * factor) / factor;
}

async function placeOrder(symbol, side, size, options = {}) {
    if (isSimulation) {
        console.log(`[SIMULATION] ${side} ${size} ${symbol}`, options);
        return { simulated: true, symbol, side, size };
    }

    return side === 'SELL'
        ? binance.futuresSell(symbol, size, undefined, options)
        : binance.futuresBuy(symbol, size, undefined, options);
}

async function openOrder(symbol) {
    try {
        const { basePrecision, minNotional } = await getAssetInfo(symbol);
        const { availableBalance } = await binance.futuresAccount();
        const riskAmount = Math.max(minNotional, availableBalance * 0.2);
        const price = await getCurrentPrice(symbol);
        const size = roundToPrecision(riskAmount / price, basePrecision);
        return placeOrder(symbol, 'SELL', size, { leverage: 20 });
    } catch (error) {
        console.error(`Open order error for ${symbol}:`, error);
    }
}

async function reverseFailingPosition(position) {
    const { symbol } = position;
    const { basePrecision, minNotional } = await getAssetInfo(symbol);
    const { availableBalance } = await binance.futuresAccount();
    const riskAmount = Math.max(minNotional, availableBalance * 0.2);
    const price = await getCurrentPrice(symbol);
    const size = roundToPrecision((riskAmount / price) * 2, basePrecision);

    const side = Number(position.positionAmt) > 0 ? 'SELL' : 'BUY';
    return placeOrder(symbol, side, size, { leverage: 20 });
}

function calculateROE(position) {
    const entry = parseFloat(position.entryPrice);
    const mark = parseFloat(position.markPrice);
    const amt = parseFloat(position.positionAmt);
    const leverage = parseFloat(position.leverage);
    const pnl = parseFloat(position.unRealizedProfit);
    const currentValue = amt * mark;
    const initialMargin = currentValue / leverage;
    const roe = ((pnl / initialMargin) * 100).toFixed(2);
    return pnl >= 0 ? Math.abs(roe) : -Math.abs(roe);
}

async function openOrdersSequentially(openSymbols, symbols) {
    for (const symbol of symbols) {
        if (!openSymbols.includes(symbol)) {
            const res = await openOrder(symbol);
            console.log(`Opened order for ${symbol}`, res);
        }
    }
}

async function start() {
    const { serverTime } = await binance.time();
    let positions = await binance.futuresPositionRisk({ timestamp: serverTime }) || [];
    const openPositions = positions.filter(p => Number(p.positionAmt) !== 0);
    const openSymbols = openPositions.map(p => p.symbol);

    const symbols = ["IMXUSDT", "XRPUSDT", "DOGEUSDT", "BALUSDT", "EOSUSDT", "BATUSDT", "BELUSDT"];
    await openOrdersSequentially(openSymbols, symbols);

    for (const pos of openPositions) {
        const current = positions.find(p => p.symbol === pos.symbol);
        const ROE = calculateROE(current);
        console.table({ symbol: pos.symbol, ROE, PnL: pos.unRealizedProfit });

        if (ROE < -10) {
            const res = await reverseFailingPosition(current);
            console.log(`Flipped position for ${pos.symbol}`, res);
        }
    }
}

start();