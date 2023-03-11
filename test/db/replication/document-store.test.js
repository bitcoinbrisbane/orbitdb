import { deepStrictEqual } from 'assert'
import rmrf from 'rimraf'
import { copy } from 'fs-extra'
import * as IPFS from 'ipfs'
import { Log, Entry, Database, KeyStore, Identities } from '../../../src/index.js'
import { DocumentStore } from '../../../src/db/index.js'
import config from '../../config.js'
import testKeysPath from '../../fixtures/test-keys-path.js'
import connectPeers from '../../utils/connect-nodes.js'
import waitFor from '../../utils/wait-for.js'

const OpLog = { Log, Entry }
const keysPath = './testkeys'

describe('Documents Database Replication', function () {
  this.timeout(30000)

  let ipfs1, ipfs2
  let keystore
  let identities
  let testIdentity1, testIdentity2
  let db1, db2

  const databaseId = 'documentstore-AAA'

  const accessController = {
    canAppend: async (entry) => {
      const identity1 = await identities.getIdentity(entry.identity)
      const identity2 = await identities.getIdentity(entry.identity)
      return identity1.id === testIdentity1.id || identity2.id === testIdentity2.id
    }
  }

  before(async () => {
    ipfs1 = await IPFS.create({ ...config.daemon1, repo: './ipfs1' })
    ipfs2 = await IPFS.create({ ...config.daemon2, repo: './ipfs2' })
    await connectPeers(ipfs1, ipfs2)

    await copy(testKeysPath, keysPath)
    keystore = await KeyStore({ path: keysPath })
    identities = await Identities({ keystore })
    testIdentity1 = await identities.createIdentity({ id: 'userA' })
    testIdentity2 = await identities.createIdentity({ id: 'userB' })
  })

  after(async () => {
    if (ipfs1) {
      await ipfs1.stop()
    }

    if (ipfs2) {
      await ipfs2.stop()
    }

    if (keystore) {
      await keystore.close()
    }

    await rmrf(keysPath)
    await rmrf('./orbitdb1')
    await rmrf('./orbitdb2')
    await rmrf('./ipfs1')
    await rmrf('./ipfs2')
  })

  beforeEach(async () => {
    db1 = await DocumentStore({ OpLog, Database, ipfs: ipfs1, identity: testIdentity1, address: databaseId, accessController, directory: './orbitdb1' })
    db2 = await DocumentStore({ OpLog, Database, ipfs: ipfs2, identity: testIdentity2, address: databaseId, accessController, directory: './orbitdb2' })
  })

  afterEach(async () => {
    if (db1) {
      await db1.drop()
      await db1.close()
    }
    if (db2) {
      await db2.drop()
      await db2.close()
    }
  })

  it('replicates documents across two peers', async () => {
    let connected1 = false
    let connected2 = false

    const onConnected1 = async (peerId, heads) => {
      connected1 = true
    }

    const onConnected2 = async (peerId, heads) => {
      connected2 = true
    }

    db1.events.on('join', onConnected1)
    db2.events.on('join', onConnected2)

    await db1.put({ _id: 1, msg: 'record 1 on db 1' })
    await db2.put({ _id: 2, msg: 'record 2 on db 2' })
    await db1.put({ _id: 3, msg: 'record 3 on db 1' })
    await db2.put({ _id: 4, msg: 'record 4 on db 2' })

    await waitFor(() => connected1, () => true)
    await waitFor(() => connected2, () => true)

    const all1 = []
    for await (const item of db1.iterator()) {
      all1.unshift(item)
    }

    const all2 = []
    for await (const item of db2.iterator()) {
      all2.unshift(item)
    }

    deepStrictEqual(all1, all2)
  })
})
