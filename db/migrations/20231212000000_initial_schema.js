/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
    // Config
    const hasConfig = await knex.schema.hasTable('config');
    if (!hasConfig) {
        await knex.schema.createTable('config', function (table) {
            table.string('key').primary();
            table.text('value').notNullable();
            table.integer('updated_at').defaultTo(knex.raw("(strftime('%s', 'now'))"));
        });

        // Seed default config only if table was just created
        await knex('config').insert([
            { key: 'targetCsmsUrl', value: 'ws://localhost/ocpp', updated_at: Math.floor(Date.now() / 1000) },
            { key: 'csmsForwardingEnabled', value: 'false', updated_at: Math.floor(Date.now() / 1000) },
            { key: 'port', value: '8080', updated_at: Math.floor(Date.now() / 1000) },
            { key: 'autoChargeEnabled', value: 'false', updated_at: Math.floor(Date.now() / 1000) },
            { key: 'defaultIdTag', value: 'ADMIN_TAG', updated_at: Math.floor(Date.now() / 1000) }
        ]).onConflict('key').ignore();
    }

    // Logs
    const hasLogs = await knex.schema.hasTable('logs');
    if (!hasLogs) {
        await knex.schema.createTable('logs', function (table) {
            table.increments('id');
            table.string('charge_point_id').notNullable();
            table.string('direction').notNullable();
            table.text('payload').notNullable();
            table.integer('timestamp').notNullable();

            table.index(['charge_point_id', 'timestamp']);
            table.index(['timestamp']);
        });
    }

    // Chargers
    const hasChargers = await knex.schema.hasTable('chargers');
    if (!hasChargers) {
        await knex.schema.createTable('chargers', function (table) {
            table.string('charge_point_id').primary();
            table.string('status').notNullable();
            table.integer('last_seen').notNullable();
        });
    }

    // Auth Users
    const hasAuth = await knex.schema.hasTable('auth_users');
    if (!hasAuth) {
        await knex.schema.createTable('auth_users', function (table) {
            table.string('username').primary();
            table.string('password_hash').notNullable();
            table.integer('created_at').notNullable();
        });
    }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
    return knex.schema
        .dropTableIfExists('auth_users')
        .dropTableIfExists('chargers')
        .dropTableIfExists('logs')
        .dropTableIfExists('config');
};
