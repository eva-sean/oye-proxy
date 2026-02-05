// Update with your config settings.
const path = require('path');
require('dotenv').config();

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
module.exports = {

  development: {
    client: 'sqlite3',
    connection: {
      // Use in-memory database if USE_MEMORY_DB is true, otherwise use file
      filename: process.env.USE_MEMORY_DB === 'true' ? ':memory:' : (process.env.DB_PATH || path.join(__dirname, 'data/db/oye-proxy.db'))
    },
    useNullAsDefault: true,
    migrations: {
      directory: './db/migrations',
      // Disable migration lock for in-memory database (Cloud Run read-only filesystem)
      disableMigrationsListValidation: process.env.USE_MEMORY_DB === 'true'
    },
    pool: {
      // In-memory database must use single connection to preserve state
      min: 1,
      max: 1,
      afterCreate: (conn, done) => {
        // For in-memory DB, run migrations immediately on connection
        if (process.env.USE_MEMORY_DB === 'true') {
          conn.run('PRAGMA foreign_keys = ON', done);
        } else {
          done();
        }
      }
    }
  },

  production: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    },
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      directory: './db/migrations'
    }
  }

};
