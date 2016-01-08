"use strict"

module.exports = UsersControllerFactory

const request = require('five-bells-shared/utils/request')
const passport = require('koa-passport')
const UserFactory = require('../models/user')
const Auth = require('../lib/auth')
const Log = require('../lib/log')
const DB = require('../lib/db')
const Config = require('../lib/config')
const UnauthorizedError = require('five-bells-shared/errors/unauthorized-error')

UsersControllerFactory.constitute = [UserFactory, Auth, Log, DB, Config]
function UsersControllerFactory (User, auth, log, db, config) {
  log = log('users')

  return class UsersController {
    static init (router) {
      //router.get('/users/:id', auth.isAuth, this.getResource)
      router.put('/users/:id', User.createBodyParser(), this.putResource)
    }

    /*static * getResource () {
      let id = this.params.id
      request.validateUriParameter('id', id, 'Identifier')
      id = id.toLowerCase()
      log.debug('fetching user ID ' + id)

      let can_modify = this.req.user.username === id
      if (!can_modify) {
        throw new UnauthorizedError('You don\'t have permission to examine this user')
      }

      const user = yield User.findOne({where: {username: id}})
      if (!user) {
        throw new NotFoundError('Unknown user ID')
      }

      delete user.password

      this.body = user.getDataExternal()
    }*/

    // TODO create a ledger account
    static * putResource () {
      const self = this
      let id = this.params.id || ''
      request.validateUriParameter('id', id, 'Identifier')
      id = id.toLowerCase()

      // SQLite's implementation of upsert does not tell you whether it created the
      // row or whether it already existed. Since we need to know to return the
      // correct HTTP status code we unfortunately have to do this in two steps.
      let existed
      yield db.transaction(function * (transaction) {
        existed = yield User.findOne({where: {username: id}}, { transaction })
        if (existed) {
          existed.setDataExternal(self.body)
          yield existed.save({ transaction })
        } else {
          yield User.createExternal(self.body, { transaction })
        }

        // TODO callbacks?
        self.req.logIn(self.body, function (err) {})
      })

      log.debug((existed ? 'updated' : 'created') + ' user ID ' + id)

      this.body = this.body.getDataExternal()
      this.status = existed ? 200 : 201
    }
  }
}