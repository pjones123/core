/* eslint-disable max-classes-per-file */
/* eslint-disable class-methods-use-this */
/* eslint-disable camelcase */
const { promisify } = require('util');
const fs = require('fs');
const graphqlExpress = require('express-graphql');
const { buildSchema } = require('graphql');
const { game_types: gameTypes } = require('hypixelconstants');
const { getPlayer, populatePlayers } = require('../store/buildPlayer');
const buildBans = require('../store/buildBans');
const buildBoosters = require('../store/buildBoosters');
const { getAuctions, queryAuctionId } = require('../store/queryAuctions');
const { buildProfile } = require('../store/buildSkyBlockProfiles');
const { getGuildFromPlayer } = require('../store/buildGuild');
const leaderboards = require('../store/leaderboards');
const redis = require('../store/redis');
const getUUID = require('../store/getUUID');
const { generateJob, getData, typeToStandardName } = require('../util/utility');

const buildBansAsync = promisify(buildBans);
const buildBoostersAsync = promisify(buildBoosters);
const leaderboardsAsync = promisify(leaderboards);
const getGuildFromPlayerAsync = promisify(getGuildFromPlayer);
const getPlayerAsync = promisify(getPlayer);
const populatePlayersAsync = promisify(populatePlayers);
const redisGetAsync = promisify(redis.get).bind(redis);
const getUUIDAsync = promisify(getUUID);
const buildProfileAsync = promisify(buildProfile);
const getAuctionsAsync = promisify(getAuctions);
const queryAuctionIdAsync = promisify(queryAuctionId);

const gameStandardNames = gameTypes.map((game) => game.standard_name);

let schema = fs.readFileSync('./routes/spec.graphql', 'utf8');

// Dynamic schema generation
const schemaReplacements = {
  BOOSTER_QUERY: gameStandardNames.map((game) => `${game}: [GameBooster]`).join('\n'),
};

Object.entries(schemaReplacements).forEach(([phrase, replacer]) => {
  schema = schema.replace(`%${phrase}%`, replacer);
});

// Resolver classes
class BoostersResolver {
  constructor() {
    gameStandardNames.forEach((game) => {
      this[game] = async () => {
        const boosters = await buildBoostersAsync();
        return boosters.boosters[game];
      };
    });
  }

  async all() {
    const { boosters } = await buildBoostersAsync();
    return Object.entries(boosters).reduce((prev, [game, value]) => [...prev, { game, boosters: value }], []);
  }
}

class PlayersResolver {
  player({ player_name /* , fields */ }) {
    // TODO: Remove 'fields' param from the /players/{player_name} route.
    // If someone wants specific fields, they should use graphql.
    return getPlayerAsync(player_name);
  }

  async achievements({ player_name }) {
    const player = await getPlayerAsync(player_name);
    return player.achievements;
  }

  async quests({ player_name }) {
    const player = await getPlayerAsync(player_name);
    return player.quests;
  }

  recent_games({ player_name }) {
    // TODO: Extract common code from here and spec.js
    return new Promise((resolve, reject) => {
      getUUID(player_name, (err, uuid) => {
        if (err) {
          return reject(err);
        }
        getData(redis, generateJob('recentgames', { id: uuid }).url, (err, data) => {
          if (err) {
            return reject(err);
          }
          try {
            return resolve(
              data.games.map((game) => {
                game.gameType = typeToStandardName(game.gameType);
                return game;
              }),
            );
          } catch (e) {
            return reject(e);
          }
        });
        return undefined;
      });
    });
  }
}

const graphql = graphqlExpress({
  schema: buildSchema(schema),
  rootValue: {
    bans() {
      return buildBansAsync();
    },

    boosters() {
      return new BoostersResolver();
    },

    get_leaderboard_template({ template }) {
      return leaderboardsAsync(undefined, template);
    },

    guild({ player_name, populate_players }) {
      return getGuildFromPlayerAsync(player_name, populate_players);
    },

    leaderboards(params) {
      return leaderboardsAsync(params, null);
    },

    players() {
      return new PlayersResolver();
    },

    async skyblock_auctions_item({ from, item_id, to }) {
      console.log(`ID: ${item_id}`);
      const result = await queryAuctionIdAsync(from, to, item_id);
      console.log(JSON.stringify(result));
      return result;
    },

    async skyblock_auctions(params) {
      return getAuctionsAsync(params);
    },

    async skyblock_items() {
      return JSON.parse(await redisGetAsync('skyblock_items'));
    },

    async skyblock_profiles({ player_name }) {
      const uuid = await getUUIDAsync(player_name);
      const profiles = await redisGetAsync(`skyblock_profiles:${uuid}`);
      return profiles ? JSON.parse(profiles) : {};
    },

    async skyblock_profile({ player_name, profile_id }) {
      const uuid = await getUUIDAsync(player_name);
      const profile = await buildProfileAsync(uuid, profile_id);
      const players = await populatePlayersAsync(Object.keys(profile.members).map((uuid) => ({ uuid })));

      players.forEach((player) => {
        profile.members[player.profile.uuid].player = player.profile;
      });

      return profile;
    },
  },
});

module.exports = graphql;
