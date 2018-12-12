const hashlocks = require('hashlocks');
const randomBytes = require('randombytes');
const { runSql, getObject, getValue } = require('./db');
const { newTransaction } = require('./ledger');

async function loop(userId, obj, hubbie) {
  if (typeof userId !== 'number') {
    throw new Error('snapOut: userId not a number');
  }
  if (typeof obj !== 'object') {
    throw new Error('snapOut: obj not an object');
  }
  if (typeof obj.amount !== 'number') {
    throw new Error('snapOut: obj.amount not a number');
  }
  if (typeof obj.contactName !== 'string') {
    throw new Error('snapOut: obj.contactName not a string');
  }
  // console.log('snapOut', userId, obj);
  // console.log('will create transaction with msgId', obj.msgId);
  const landmark = await getValue('SELECT landmark FROM contacts WHERE user_id= $1  AND name = $2', [userId, obj.contactName]);
  const routes = await runSql('SELECT r.* FROM routes r INNER JOIN contacts c ON r.landmark = c.landmark WHERE r.user_id = $1 AND c.user_id = $1 AND c.name = $2', [userId, obj.contactName]);
  // console.log(routes);
  const preimage = randomBytes(32);
  const hash = hashlocks.sha256(preimage);
  const condition = hash.toString('hex');
  await runSql('INSERT INTO preimages (user_id, hash, preimage) VALUES ($1, $2, $3)', [userId, condition, preimage.toString('hex')]);
  const friendId = routes[0].contact_id;
  const maxId = await getValue('SELECT MAX(msgId) AS value FROM transactions WHERE user_id = $1 AND contact_id = $2', [userId, friendId], 0);
  const trans = {
    msgType: 'PROPOSE',
    msgId: maxId + 1,
    amount: obj.amount,
    landmark,
    condition,
  };
  const friend = await getObject('SELECT * FROM contacts WHERE user_id = $1 AND id = $2', [userId, friendId]);
  try {
    await newTransaction(userId, friend, trans, 'OUT', hubbie);
  } catch (e) {
    // console.error('snapOut fail', e.message);
    throw e;
  }
  // console.log('hubbie send out', userId, friend, inserted, trans);
  // in server-to-server http cross post,
  // the existence of a contact allows incoming http but also outgoing
  // a useful common practice is if the username+token is the same in both directions
  // when that happens, hubbie channels can be used in both directions.
  // When not, you would use two hubbie channels, one dedicated for incoming, and one
  // for outgoing. Not a big deal, but unnecessarily confusing.
  // Only downside: you need to give your peer a URL that ends in the name they have
  // in your addressbook.
  // For now, we use a special hubbie channel to make the outgoing call:
  const peerName = `${userId}:${friend.name}`;
  hubbie.addClient({
    peerUrl: friend.url,
    myName: /* fixme: hubbie should omit myName before mySecret in outgoing url */ friend.token,
    peerName,
  });
  return hubbie.send(peerName, JSON.stringify(trans));
}

module.exports = { loop };