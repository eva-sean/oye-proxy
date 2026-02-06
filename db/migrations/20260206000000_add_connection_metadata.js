/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
    return knex.schema.table('chargers', function (table) {
        table.string('remote_ip').nullable();
        table.integer('remote_port').nullable();
        table.integer('connected_at').nullable();
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
    return knex.schema.table('chargers', function (table) {
        table.dropColumn('remote_ip');
        table.dropColumn('remote_port');
        table.dropColumn('connected_at');
    });
};
