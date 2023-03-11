import { strictEqual, deepStrictEqual } from 'assert'
import rmrf from 'rimraf'
import { copy } from 'fs-extra'
import * as IPFS from 'ipfs'
import { Log, Entry, Database, KeyStore, Identities } from '../src/index.js'
import config from './config.js'
import testKeysPath from './fixtures/test-keys-path.js'
import connectPeers from './utils/connect-nodes.js'
import waitFor from './utils/wait-for.js'

const OpLog = { Log, Entry }
const keysPath = './testkeys'

describe('Database - Replication', function () {
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

  beforeEach(async () => {
    ipfs1 = await IPFS.create({ ...config.daemon1, repo: './ipfs1' })
    ipfs2 = await IPFS.create({ ...config.daemon2, repo: './ipfs2' })
    await connectPeers(ipfs1, ipfs2)

    await copy(testKeysPath, keysPath)
    keystore = await KeyStore({ path: keysPath })
    identities = await Identities({ keystore })
    testIdentity1 = await identities.createIdentity({ id: 'userA' })
    testIdentity2 = await identities.createIdentity({ id: 'userB' })

    db1 = await Database({ OpLog, ipfs: ipfs1, identity: testIdentity1, address: databaseId, accessController, directory: './orbitdb1' })
    db2 = await Database({ OpLog, ipfs: ipfs2, identity: testIdentity2, address: databaseId, accessController, directory: './orbitdb2' })
  })

  afterEach(async () => {
    if (db1) {
      await db1.drop()
      await db1.close()

      await rmrf('./orbitdb1')
    }
    if (db2) {
      await db2.drop()
      await db2.close()

      await rmrf('./orbitdb2')
    }

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
    await rmrf('./ipfs1')
    await rmrf('./ipfs2')
  })

  it('replicates databases across two peers', async () => {
    let connected1 = false
    let connected2 = false

    const onConnected1 = (peerId, heads) => {
      connected1 = true
    }

    const onConnected2 = (peerId, heads) => {
      connected2 = true
    }

    db1.events.on('join', onConnected1)
    db2.events.on('join', onConnected2)

    await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })
    await db1.addOperation({ op: 'PUT', key: 2, value: 'record 2 on db 1' })
    await db1.addOperation({ op: 'PUT', key: 3, value: 'record 3 on db 1' })
    await db1.addOperation({ op: 'PUT', key: 4, value: 'record 4 on db 1' })

    await waitFor(() => connected1, () => true)
    await waitFor(() => connected2, () => true)

    const all1 = []
    for await (const item of db1.log.iterator()) {
      all1.unshift(item)
    }

    const all2 = []
    for await (const item of db2.log.iterator()) {
      all2.unshift(item)
    }

    deepStrictEqual(all1, all2)
  })

  it('replicates databases across two peers with delays', async () => {
    let connected1 = false
    let connected2 = false

    const onConnected1 = (peerId, heads) => {
      connected1 = true
    }

    const onConnected2 = (peerId, heads) => {
      connected2 = true
    }

    db1.events.on('join', onConnected1)
    db2.events.on('join', onConnected2)

    await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })

    await new Promise(resolve => {
      setTimeout(() => resolve(), 1000)
    })

    await db1.addOperation({ op: 'PUT', key: 2, value: 'record 2 on db 1' })
    await db1.addOperation({ op: 'PUT', key: 3, value: 'record 3 on db 1' })

    await new Promise(resolve => {
      setTimeout(() => resolve(), 1000)
    })

    await db1.addOperation({ op: 'PUT', key: 4, value: 'record 4 on db 1' })

    await waitFor(() => connected1, () => true)
    await waitFor(() => connected2, () => true)

    const all1 = []
    for await (const item of db1.log.iterator()) {
      all1.unshift(item)
    }

    const all2 = []
    for await (const item of db2.log.iterator()) {
      all2.unshift(item)
    }

    deepStrictEqual(all1, all2)
  })

  it('adds an operation before db2 is instantiated', async () => {
    let connected = false
    const onConnected = (peerId, heads) => {
      connected = true
    }

    await db2.drop()
    await db2.close()

    await rmrf('./orbitdb2')

    await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })

    db2 = await Database({ OpLog, ipfs: ipfs2, identity: testIdentity2, address: databaseId, accessController, directory: './orbitdb2' })

    db2.events.on('join', onConnected)

    await waitFor(() => connected, () => true)

    const all1 = []
    for await (const item of db1.log.iterator()) {
      all1.unshift(item)
    }

    const all2 = []
    for await (const item of db2.log.iterator()) {
      all2.unshift(item)
    }

    deepStrictEqual(all1, all2)
  })

  describe('Events', () => {
    it('emits \'update\' once when one operation is added', async () => {
      const expected = 1
      let connected1 = false
      let connected2 = false
      let updateCount1 = 0
      let updateCount2 = 0

      const onConnected1 = (peerId, heads) => {
        connected1 = true
      }

      const onConnected2 = (peerId, heads) => {
        connected2 = true
      }

      const onUpdate1 = async (entry) => {
        ++updateCount1
      }

      const onUpdate2 = async (entry) => {
        ++updateCount2
      }

      db1.events.on('join', onConnected1)
      db2.events.on('join', onConnected2)
      db1.events.on('update', onUpdate1)
      db2.events.on('update', onUpdate2)

      await waitFor(() => connected1, () => true)
      await waitFor(() => connected2, () => true)

      await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })

      await waitFor(() => updateCount1 >= expected, () => true)
      await waitFor(() => updateCount2 >= expected, () => true)

      strictEqual(updateCount1, expected)
      strictEqual(updateCount2, expected)
    })

    it('emits \'update\' 4 times when 4 documents are added', async () => {
      const expected = 4
      let connected1 = false
      let connected2 = false
      let updateCount1 = 0
      let updateCount2 = 0

      const onConnected1 = async (peerId, heads) => {
        connected1 = true
      }

      const onConnected2 = async (peerId, heads) => {
        connected2 = true
      }

      const onUpdate1 = async (entry) => {
        ++updateCount1
      }

      const onUpdate2 = async (entry) => {
        ++updateCount2
      }

      db1.events.on('join', onConnected1)
      db2.events.on('join', onConnected2)
      db1.events.on('update', onUpdate1)
      db2.events.on('update', onUpdate2)

      await waitFor(() => connected1, () => true)
      await waitFor(() => connected2, () => true)

      await db1.addOperation({ op: 'PUT', key: 1, value: '11' })
      await db1.addOperation({ op: 'PUT', key: 2, value: '22' })
      await db1.addOperation({ op: 'PUT', key: 3, value: '33' })
      await db1.addOperation({ op: 'PUT', key: 4, value: '44' })

      await waitFor(() => updateCount1 >= expected, () => true)
      await waitFor(() => updateCount2 >= expected, () => true)

      strictEqual(updateCount1, expected)
      strictEqual(updateCount2, expected)
    })
  })
})
