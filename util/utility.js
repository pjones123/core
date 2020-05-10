/**
 * Provides utility functions.
 * All functions should have external dependencies (DB, etc.) passed as parameters
 * */
const constants = require('hypixelconstants');
const { fromPromise } = require('universalify');
const urllib = require('url');
const { v4: uuidV4 } = require('uuid');
const moment = require('moment');
const nbt = require('prismarine-nbt');
const { createLogger, format, transports } = require('winston');
const pify = require('pify');
const got = require('got');

const config = require('../config');
const contributors = require('../CONTRIBUTORS');
const profileFields = require('../store/profileFields');
const {
  max, min, average, median, stdDev,
} = require('./math');

const logger = createLogger({
  transports: [new transports.Console()],
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`),
  ),
});
if (config.NODE_ENV === 'development' || config.NODE_ENV === 'test') logger.level = 'debug';

function betterFormatting(i) {
  if (typeof i !== 'string') {
    return (i);
  }
  return (i.replace(/Â§/g, '§').replace(/§/g, '&'));
}

function removeFormatting(i) {
  return i.replace(/§./g, '');
}

function removeDashes(i) {
  return (i.replace(/-/g, ''));
}

/*
* Get ratio of x from y. Returns 2 decimal places.
 */
function getRatio(x = 0, y = 0) {
  if (x === 0) {
    return 0;
  }
  if (y === 0) {
    return null;
  }
  return Number((x / y).toFixed(2));
}

/*
* Decode SkyBlock inventory data
 */
function decodeData(string, callback) {
  const data = Buffer.from(string, 'base64');
  nbt.parse(data, (error, json) => {
    if (error) {
      logger.error(error);
    }
    return callback(error, json);
  });
}

/*
 * Gets the correct weekly statistic from the two oscillating
 * weekly fields.
 */
function getWeeklyStat(a, b) {
  const delta = new Date() - new Date(1417237200000);
  const numberWeeks = Math.floor(delta / 604800000);

  return numberWeeks % 2 === 0 ? a : b;
}

/*
 * Gets the correct monthly statistic from the two oscillating
 * monthly fields.
 */
function getMonthlyStat(a, b) {
  const start = new Date();
  const end = new Date(1417410000000);

  const diffYear = end.getFullYear() - start.getFullYear();
  const diffMonth = diffYear * 12 + end.getMonth() - start.getMonth();

  return diffMonth % 2 === 0 ? a : b;
}

function fromEntries(array) {
  return array.reduce((object, [key, value]) => {
    object[key] = value;
    return object;
  }, {});
}

/*
 * Pick certain keys from obj.
 *
 * Options:
 *    regexp: A regex object that the keys must pass.
 *        Defaults to .*
 *    filter: A function that is passed both the key
 *        and value, and returns a boolean. Defaults
 *        to (() => true).
 *    keyMap: A function that remaps all keys that
 *        pass the above two tests. Defaults to
 *        (key => key).
 *    valueMap: Same as keyMap, but for the values.
 */
function pickKeys(object, options) {
  const regexp = options.regexp || /.+/;
  const filter = options.filter || (() => true);
  const keyMap = options.keyMap || ((key) => key);
  const valueMap = options.valueMap || ((value) => value);

  return fromEntries(Object.entries(object)
    .filter(([key, value]) => regexp.test(key) && filter(key, value))
    .map(([key, value]) => [keyMap(key), valueMap(value)]));
}

/**
 * Converts minigames ID to standard name e.g. 3 => Walls
 */
function IDToStandardName(name = '') {
  const result = constants.game_types.find((game) => game.id === Number(name));
  return result === undefined ? name : result.standard_name;
}

/**
 * Converts minigames database name to standard name e.g. GingerBread => TKR
 */
function DBToStandardName(name = '') {
  const result = constants.game_types.find((game) => game.database_name.toLowerCase() === name.toLowerCase());
  return result === undefined ? name : result.standard_name;
}

/**
* Converts minigames type to standard name e.g. QUAKECRAFT => Quake
 */
function typeToStandardName(name) {
  const result = constants.game_types.find((game) => game.type_name === name);
  return result === undefined ? name : result.standard_name;
}

/**
 * Determines if a player has contributed to the development of Slothpixel
 */
const isContributor = (uuid) => contributors.includes(uuid);

/**
* Allows you to use dot syntax for nested objects, e.g. 'tag.value.display'
 */
function getNestedObjects(object = {}, path = '') {
  path = path.split('.');

  for (const element of path) {
    if (object[element] === undefined) {
      return object;
    }
    object = object[element];
  }
  return object;
}

/**
* Returns specified+profile fields from a player objects
 */
function getPlayerFields(object = {}, fields = []) {
  const result = {};
  fields.concat(profileFields).forEach((field) => {
    result[field] = getNestedObjects(object, field);
  });
  return result;
}

/**
 * Returns the unix timestamp at the beginning of a block of n minutes
 * Offset controls the number of blocks to look ahead
 * */
function getStartOfBlockMinutes(size, offset = 0) {
  const blockS = size * 60;
  const currentTime = Math.floor(new Date() / 1000);
  const blockStart = currentTime - (currentTime % blockS);
  return (blockStart + (offset * blockS)).toFixed(0);
}

function getEndOfMonth() {
  return moment().endOf('month').unix();
}

function redisCount(redis, prefix) {
  const key = `${prefix}:${moment().startOf('hour').format('X')}`;
  redis.pfadd(key, uuidV4());
  redis.expireat(key, moment().startOf('hour').add(1, 'day').format('X'));
}

function getRedisCountDay(redis, prefix, callback) {
  // Get counts for last 24 hour keys (including current partial hour)
  const keyArray = [];
  for (let i = 0; i < 24; i += 1) {
    keyArray.push(`${prefix}:${moment().startOf('hour').subtract(i, 'hour').format('X')}`);
  }
  redis.pfcount(...keyArray, callback);
}

function getRedisCountHour(redis, prefix, callback) {
  // Get counts for previous full hour
  const keyArray = [];
  for (let i = 1; i < 2; i += 1) {
    keyArray.push(`${prefix}:${moment().startOf('hour').subtract(i, 'hour').format('X')}`);
  }
  redis.pfcount(...keyArray, callback);
}

const randomItem = (array) => array[Math.floor(Math.random() * array.length)];

/**
 * Creates a job object for enqueueing that contains details such as the Hypixel endpoint to hit
 * See https://github.com/HypixelDev/PublicAPI/tree/master/Documentation/methods
 * */
function generateJob(type, payload) {
  logger.debug(`generateJob ${type}`);
  const apiUrl = 'https://api.hypixel.net';
  const apiKeys = config.HYPIXEL_API_KEY.split(',');
  const apiKey = randomItem(apiKeys);
  if (apiKey === '') {
    logger.warn('No HYPIXEL_API_KEY env variable set!');
  }
  const options = {
    bazaar_products() {
      return {
        url: `${apiUrl}/skyblock/bazaar?key=${apiKey}`,
      };
    },
    boosters() {
      return {
        url: `${apiUrl}/boosters?key=${apiKey}`,
      };
    },
    findguild() {
      return {
        url: `${apiUrl}/findguild?key=${apiKey}&byUuid=${payload.id}`,
      };
    },
    friends() {
      return {
        url: `${apiUrl}/friends?key=${apiKey}&uuid=${payload.id}`,
      };
    },
    guild() {
      return {
        url: `${apiUrl}/guild?key=${apiKey}&id=${payload.id}`,
      };
    },
    gamecounts() {
      return {
        url: `${apiUrl}/gamecounts?key=${apiKey}`,
      };
    },
    key() {
      return {
        url: `${apiUrl}/key?key=${apiKey}`,
      };
    },
    recentgames() {
      return {
        url: `${apiUrl}/recentGames?key=${apiKey}&uuid=${payload.id}`,
      };
    },
    skyblock_auctions() {
      return {
        url: `${apiUrl}/skyblock/auctions?key=${apiKey}&page=${payload.page}`,
      };
    },
    skyblock_profile() {
      return {
        url: `${apiUrl}/skyblock/profile?key=${apiKey}&profile=${payload.id}`,
      };
    },
    player() {
      return {
        url: `${apiUrl}/player?key=${apiKey}&uuid=${payload.id}`,
      };
    },
    watchdogstats() {
      return {
        url: `${apiUrl}/watchdogstats?key=${apiKey}`,
      };
    },

  };
  return options[type]();
}

/**
 * A wrapper around HTTPS requests that handles:
 * retries/retry delay
 * Injecting API key for Hypixel API
 * Errors from Hypixel API
 * */
const getData = fromPromise(async (redis, url) => {
  if (typeof url === 'string') {
    url = {
      url,
    };
  }

  url = {
    delay: Number(config.DEFAULT_DELAY),
    timeout: 20000,
    retries: 10,
    ...url,
  };

  const urlData = urllib.parse(url.url, true);
  const isHypixelApi = urlData.host === 'api.hypixel.net';
  const isMojangApi = urlData.host === 'api.mojang.com';

  const target = urllib.format(urlData);

  logger.info(`getData: ${target}`);

  try {
    const { body } = await got(target, {
      responseType: isHypixelApi ? 'json' : 'text',
      timeout: url.timeout,
      retry: url.retries,
      hooks: {
        beforeRetry: [
          async () => {
            if (isHypixelApi) {
              const multi = redis.multi()
                .incr('hypixel_api_error')
                .expireat('hypixel_api_error', getStartOfBlockMinutes(1, 1));

              try {
                const [failed] = await pify(multi.exec)();
                logger.warn(`Failed API requests in the past minute: ${failed}`);
                logger.error(`[INVALID] data: ${target}, retrying ${JSON.stringify(body)}`);
              } catch (error) {
                logger.error(error);
              }
            }
          },
        ],
      },
    });

    return body;
  } catch (error) {
    if (url.noRetry) {
      throw new Error('Invalid response');
    }
    if (isMojangApi) {
      throw new Error('Failed to get player uuid');
    }
    logger.error(`[INVALID] error: ${error}`);
    throw new Error(`[INVALID] error: ${error}`);
  }
});

function colorNameToCode(color) {
  if (color === null) {
    return (null);
  }
  switch (color.toLowerCase()) {
    case 'gray':
      return ('&7');
    case 'red':
      return ('&c');
    case 'green':
      return ('&a');
    case 'aqua':
      return ('&b');
    case 'gold':
      return ('&6');
    case 'light_purple':
      return ('&d');
    case 'yellow':
      return ('&e');
    case 'white':
      return ('&f');
    case 'blue':
      return ('&9');
    case 'dark_green':
      return ('&2');
    case 'dark_red':
      return ('&4');
    case 'dark_aqua':
      return ('&3');
    case 'dark_purple':
      return ('&5');
    case 'dark_gray':
      return ('&8');
    case 'black':
      return ('&0');
    default:
      return (null);
  }
}

function generateFormattedRank(rank, plusColor, prefix, plusPlusColor) {
  if (prefix) {
    return prefix;
  }
  switch (rank) {
    case 'VIP':
      return '&a[VIP]';
    case 'VIP_PLUS':
      return '&a[VIP&6+&a]';
    case 'MVP':
      return '&b[MVP]';
    case 'MVP_PLUS':
      return `&b[MVP${plusColor}+&b]`;
    case 'MVP_PLUS_PLUS':
      return `${plusPlusColor}[MVP${plusColor}++${plusPlusColor}]`;
    case 'HELPER':
      return '&9[HELPER]';
    case 'MODERATOR':
      return '&2[MOD]';
    case 'ADMIN':
      return '&c[ADMIN]';
    case 'YOUTUBER':
      return '&c[&fYOUTUBER&c]';
    default:
      return '&7';
  }
}

function invokeInterval(func, delay) {
  // invokes the function immediately, waits for callback, waits the delay, and then calls it again
  (function invoker() {
    logger.info(`running ${func.name}`);
    const start = Date.now();
    return func((error) => {
      if (error) {
        // log the error, but wait until next interval to retry
        logger.error(error);
      }
      logger.info(`${func.name}: ${Date.now() - start}ms`);
      setTimeout(invoker, delay);
    });
  }());
}

module.exports = {
  logger,
  betterFormatting,
  removeFormatting,
  IDToStandardName,
  DBToStandardName,
  typeToStandardName,
  isContributor,
  getNestedObjects,
  getPlayerFields,
  generateJob,
  getData,
  getStartOfBlockMinutes,
  getEndOfMonth,
  redisCount,
  getRedisCountDay,
  getRedisCountHour,
  removeDashes,
  getRatio,
  decodeData,
  colorNameToCode,
  generateFormattedRank,
  getWeeklyStat,
  getMonthlyStat,
  pickKeys,
  invokeInterval,
  min,
  max,
  average,
  stdDev,
  median,
  fromEntries,
};
