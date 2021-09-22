'use strict';

const _ = require('lodash/fp');

const helpers = require('./helpers');

const createQueryBuilder = (uid, db) => {
  const meta = db.metadata.get(uid);
  const { tableName } = meta;

  const state = {
    type: 'select',
    select: [],
    count: null,
    first: false,
    data: null,
    where: [],
    joins: [],
    populate: null,
    limit: null,
    offset: null,
    orderBy: [],
    groupBy: [],
  };

  let counter = 0;
  const getAlias = () => `t${counter++}`;

  return {
    alias: getAlias(),
    getAlias,

    select(args) {
      state.type = 'select';
      state.select = _.uniq(_.castArray(args));

      return this;
    },

    addSelect(args) {
      state.select = _.uniq([...state.select, ..._.castArray(args)]);

      return this;
    },

    insert(data) {
      state.type = 'insert';
      state.data = data;

      return this;
    },

    delete() {
      state.type = 'delete';

      return this;
    },

    ref(name) {
      return db.connection.ref(name);
    },

    update(data) {
      state.type = 'update';
      state.data = data;

      return this;
    },

    count(count = '*') {
      state.type = 'count';
      state.count = count;

      return this;
    },

    where(where = {}) {
      if (!_.isPlainObject(where)) {
        throw new Error('Where must be an object');
      }

      state.where.push(where);

      return this;
    },

    limit(limit) {
      state.limit = limit;
      return this;
    },

    offset(offset) {
      state.offset = offset;
      return this;
    },

    orderBy(orderBy) {
      state.orderBy = orderBy;
      return this;
    },

    groupBy(groupBy) {
      state.groupBy = groupBy;
      return this;
    },

    populate(populate) {
      state.populate = populate;
      return this;
    },

    search(query) {
      state.search = query;
      return this;
    },

    init(params = {}) {
      const { _q, where, select, limit, offset, orderBy, groupBy, populate } = params;

      if (!_.isNil(where)) {
        this.where(where);
      }

      if (!_.isNil(_q)) {
        this.search(_q);
      }

      if (!_.isNil(select)) {
        this.select(select);
      } else {
        this.select('*');
      }

      if (!_.isNil(limit)) {
        this.limit(limit);
      }

      if (!_.isNil(offset)) {
        this.offset(offset);
      }

      if (!_.isNil(orderBy)) {
        this.orderBy(orderBy);
      }

      if (!_.isNil(groupBy)) {
        this.groupBy(groupBy);
      }

      if (!_.isNil(populate)) {
        this.populate(populate);
      }

      // todo: should we handle publication state on this layer ? Currently only handled in the entity service

      return this;
    },

    first() {
      state.first = true;
      return this;
    },

    join(join) {
      state.joins.push(join);
      return this;
    },

    mustUseAlias() {
      return ['select', 'count'].includes(state.type);
    },

    aliasColumn(columnName, alias) {
      if (typeof columnName !== 'string') {
        return columnName;
      }

      if (columnName.indexOf('.') >= 0) {
        return columnName;
      }

      if (!_.isNil(alias)) {
        return `${alias}.${columnName}`;
      }

      return this.mustUseAlias() ? `${this.alias}.${columnName}` : columnName;
    },

    raw(...args) {
      return db.connection.raw(...args);
    },

    shouldUseSubQuery() {
      return ['delete', 'update'].includes(state.type) && state.joins.length > 0;
    },

    runSubQuery() {
      this.select('id');
      const subQB = this.getKnexQuery();

      const nestedSubQuery = db.connection.select('id').from(subQB.as('subQuery'));

      return db
        .connection(tableName)
        [state.type]()
        .whereIn('id', nestedSubQuery);
    },

    processState() {
      state.orderBy = helpers.processOrderBy(state.orderBy, { qb: this, uid, db });
      state.where = helpers.processWhere(state.where, { qb: this, uid, db });
      state.populate = helpers.processPopulate(state.populate, { qb: this, uid, db });
    },

    getKnexQuery() {
      if (!state.type) {
        this.select('*');
      }

      const aliasedTableName = this.mustUseAlias() ? { [this.alias]: tableName } : tableName;

      const qb = db.connection(aliasedTableName);

      if (this.shouldUseSubQuery()) {
        return this.runSubQuery();
      }

      this.processState();

      switch (state.type) {
        case 'select': {
          if (state.select.length === 0) {
            state.select = ['*'];
          }

          if (state.joins.length > 0 && _.isEmpty(state.groupBy)) {
            // add a discting when making joins and if we don't have a groupBy
            // TODO: make sure we return the right data
            qb.distinct(this.aliasColumn('id'));

            // TODO: add column if they aren't there already
            state.select.unshift(...state.orderBy.map(({ column }) => column));
          }

          qb.select(state.select.map(column => this.aliasColumn(column)));
          break;
        }
        case 'count': {
          qb.count({ count: state.count });
          break;
        }
        case 'insert': {
          qb.insert(state.data);

          if (db.dialect.useReturning() && _.has('id', meta.attributes)) {
            qb.returning('id');
          }

          break;
        }
        case 'update': {
          qb.update(state.data);
          break;
        }
        case 'delete': {
          qb.delete();

          break;
        }
        case 'truncate': {
          db.truncate();
          break;
        }
      }

      if (state.limit) {
        qb.limit(state.limit);
      }

      if (state.offset) {
        qb.offset(state.offset);
      }

      if (state.orderBy.length > 0) {
        qb.orderBy(state.orderBy);
      }

      if (state.first) {
        qb.first();
      }

      if (state.groupBy.length > 0) {
        qb.groupBy(state.groupBy);
      }

      // if there are joins and it is a delete or update use a sub query
      if (state.where) {
        helpers.applyWhere(qb, state.where);
      }

      // if there are joins and it is a delete or update use a sub query
      if (state.search) {
        qb.where(subQb => {
          helpers.applySearch(subQb, state.search, { alias: this.alias, db, uid });
        });
      }

      if (state.joins.length > 0) {
        helpers.applyJoins(qb, state.joins);
      }

      return qb;
    },

    async execute({ mapResults = true } = {}) {
      try {
        const qb = this.getKnexQuery();

        const rows = await qb;

        if (state.populate && !_.isNil(rows)) {
          await helpers.applyPopulate(_.castArray(rows), state.populate, { qb: this, uid, db });
        }

        let results = rows;
        if (mapResults && state.type === 'select') {
          results = helpers.fromRow(meta, rows);
        }

        return results;
      } catch (error) {
        db.dialect.transformErrors(error);
      }
    },
  };
};

module.exports = createQueryBuilder;
