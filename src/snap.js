const hashlocks = require('hashlocks');

const db = require('./db');
const routing = require('./routing');
const { newTransaction } = require('./ledger');

async function snapOut(userId, objIn, hubbie) {
  if (typeof userId !== 'number') {
    throw new Error('snapOut: userId not a number');
  }
  if (typeof objIn !== 'object') {
    throw new Error('snapOut: obj not an object');
  }
  if (typeof objIn.amount !== 'number') {
    throw new Error('snapOut: obj.amount not a number');
  }
  if (typeof objIn.contactName !== 'string') {
    throw new Error('snapOut: obj.contactName not a string');
  }
  const maxId = await db.getValue('SELECT MAX(msgId) AS value FROM transactions', []);
  const obj = Object.assign(objIn, {
    msgId: (maxId || 0) + 1,
  });
  // console.log('snapOut', userId, obj);
  // console.log('will create transaction with msgId', obj.msgId);
  const contact = await db.getObject('SELECT id, url, token, min, max FROM contacts WHERE user_id= $1  AND name = $2', [userId, obj.contactName]);
  try {
    await newTransaction(userId, contact, obj, 'OUT', hubbie);
  } catch (e) {
    // console.error('snapOut fail', e.message);
    throw e;
  }
  // console.log('hubbie send out', userId, contact, inserted, obj);
  // in server-to-server http cross post,
  // the existence of a contact allows incoming http but also outgoing
  // a useful common practice is if the username+token is the same in both directions
  // when that happens, hubbie channels can be used in both directions.
  // When not, you would use two hubbie channels, one dedicated for incoming, and one
  // for outgoing. Not a big deal, but unnecessarily confusing.
  // Only downside: you need to give your peer a URL that ends in the name they havei
  // in your addressbook.
  // For now, we use a special hubbie channel to make the outgoing call:
  const peerName = `${userId}:${obj.contactName}`;
  hubbie.addClient({
    peerUrl: contact.url,
    myName: /* fixme: hubbie should omit myName before mySecret in outgoing url */ contact.token,
    peerName,
  });
  return hubbie.send(peerName, JSON.stringify({
    msgType: 'PROPOSE',
    msgId: obj.msgId,
    amount: obj.amount,
    description: obj.description,
    condition: obj.condition,
  }));
}

async function usePreimage(obj, userName, hubbie) {
  const userId = await db.getValue('SELECT id AS value FROM users WHERE name = $1', [userName]);
  const hash = hashlocks.sha256(Buffer.from(obj.preimage, 'hex')).toString('hex');
  // console.log('usePreimage', hash, obj);
  const backPeer = await db.getObject('SELECT incoming_peer_id, incoming_msg_id FROM forwards WHERE user_id =  $1 AND hash = $2', [
    userId,
    hash,
  ]);
  const contact = await db.getObject('SELECT name, url, token, min, max FROM contacts WHERE user_id= $1  AND id = $2', [userId, backPeer.incoming_peer_id]);
  // console.log('using in backwarded ACCEPT', contact, backPeer);
  const peerName = `${userId}:${contact.name}`;
  hubbie.addClient({
    peerUrl: contact.url,
    myName: /* fixme: hubbie should omit myName before mySecret in outgoing url */ contact.token,
    peerName,
  });
  return hubbie.send(peerName, JSON.stringify({
    msgType: 'ACCEPT',
    msgId: backPeer.incoming_msg_id,
    preimage: obj.preimage,
  }));
  // TODO: store preimages in case backPeer repeats the PROPOSE,
  // and then delete preimage rows once ACCEPT was ACKed and e.g. a week has passed
}

async function snapIn(peerName, message, userName, hubbie) {
  // console.log('hubbie message!', { peerName, message, userName });
  let obj;
  try {
    obj = JSON.parse(message);
  } catch (e) {
    throw new Error('message not json');
  }
  // console.log('snapIn message parsed', message);
  async function updateStatus(newStatus, direction) {
    const userId = await db.getValue('SELECT id AS value FROM users WHERE name = $1', [userName]);
    const contactId = await db.getValue('SELECT id AS value FROM contacts WHERE user_id = $1 AND name = $2', [userId, peerName]);
    return db.runSql('UPDATE transactions SET status = $1, responded_at = now() WHERE '
        + 'msgid = $2 AND user_id = $3 AND contact_id = $4 AND direction = $5 AND status = \'pending\'',
    [newStatus, obj.msgId, userId, contactId, direction]);
  }

  switch (obj.msgType) {
    case 'ACCEPT': {
      // console.log('ACCEPT received', userName, peerName, obj);
      updateStatus('accepted', 'OUT');
      if (obj.preimage) {
        try {
          await usePreimage(obj, userName, hubbie);
        } catch (e) {
          // console.log('ALAS, no backpeer found - or maybe I was the loop initiator');
        }
      }
      break;
    }
    case 'REJECT': {
      // console.log('REJECT received', userName, peerName, obj);
      updateStatus('rejected', 'OUT');
      break;
    }
    case 'PROPOSE': {
      const user = await db.getObject('SELECT id FROM users WHERE name = $1', [userName]);
      const contact = await db.getObject('SELECT id, url, token, min, max FROM contacts WHERE user_id= $1  AND name = $2', [user.id, peerName]);
      let result = 'ACCEPT';
      let preimage;
      try {
        if (obj.condition) {
          try {
            preimage = await db.getValue('SELECT preimage AS value FROM preimages WHERE user_id = $1 AND hash = $2', [user.id, obj.condition]);
          } catch (e) {
            // console.log('preimage  not found!~');
            // select a different peer at random:
            const forwardPeer = await db.getObject('SELECT id, name FROM contacts WHERE user_id = $1 AND name != $2', [
              user.id,
              peerName,
            ]);
            // console.log({ forwardPeer });
            await db.runSql('INSERT INTO forwards (user_id, incoming_peer_id, incoming_msg_id, outgoing_peer_id, hash) VALUES ($1, $2, $3, $4, $5)', [
              user.id,
              contact.id,
              obj.msgId,
              forwardPeer.id,
              obj.condition,
            ]);
            snapOut(user.id, {
              contactName: forwardPeer.name,
              condition: obj.condition,
              description: `DEBUG: multi-hop to ${peerName}`,
              amount: obj.amount,
            }, hubbie);
          }
        }
        // console.log({ preimage });
        // console.log('snapIn try start');
        await newTransaction(user.id, contact, obj, 'IN', hubbie);
        // TODO: could also do these two sql queries in one
        // console.log('incoming proposal accepted');
        await updateStatus('accepted', 'IN');
        // console.log('snapIn try end');
      } catch (e) {
        // console.error('snapIn fail', e.message);
        // TODO: could also do these two sql queries in one
        await updateStatus('rejected', 'IN');
        // console.log('incoming proposal rejected');
        result = 'REJECT';
      }
      // FIXME: even when using http, maybe this peer should already exist if a message is
      // being received from them?
      const channelName = `${userName}/${peerName}`; // match behavior of hubbie's internal channelName function
      hubbie.addClient({
        peerUrl: contact.url,
        /* fixme: hubbie should omit myName before mySecret in outgoing url */
        myName: contact.token,
        peerName: channelName,
      });
      // console.log('hubbie send back out', obj, channelName, user.id);
      // see FIXME comment above about peerBackName
      return hubbie.send(peerName, JSON.stringify({
        msgType: result,
        msgId: obj.msgId,
        preimage,
      }), userName);
      // break; // unreachable
    }
    case 'ROUTING': {
      await routing.storeAndForwardRoutes(userName, peerName, obj, hubbie);
      break;
    }
    case 'FRIEND-REQUEST': {
      // console.log('incoming friend request!', userName);
      const user = await db.getObject('SELECT id FROM users WHERE name = $1', [userName]);
      // console.log('friend request received', user, peerName, obj);
      await db.getValue('INSERT INTO contacts ("user_id", "name", "url", "token", "min", "max", "landmark") VALUES ($1, $2, $3, $4, $5, $6, $7)  RETURNING id AS value', [user.id, peerName, obj.url, obj.token, 0, obj.trust, `${userName}:${peerName}`]);
      break;
    }
    default:
  }
  // console.log('snapIn done');
  return Promise.resolve();
}

module.exports = { snapIn, snapOut };