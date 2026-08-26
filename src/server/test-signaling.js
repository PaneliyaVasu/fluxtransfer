/**
 * Automated test script for FluxTransfer WebSocket Signaling Server
 */
const { WebSocket } = require('ws');
const { spawn } = require('child_process');

async function runTests() {
  console.log('🧪 Starting Signaling Server Automated Tests...');

  // Start server process
  const serverProc = spawn('node', ['src/server/signaling-server.js'], {
    stdio: 'pipe'
  });

  // Wait 1 sec for server to boot
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const WS_URL = 'ws://localhost:8080';
  const testRoom = 'TEST_' + Math.floor(1000 + Math.random() * 9000);
  const tokenA = 'token_A_' + Math.random();
  const tokenB = 'token_B_' + Math.random();

  try {
    // Client 1 (Initiator with tokenA)
    const client1 = new WebSocket(WS_URL);
    await new Promise((resolve) => client1.on('open', resolve));
    console.log('✓ Client 1 connected');

    client1.send(JSON.stringify({ type: 'join-room', room: testRoom, peerToken: tokenA }));

    const c1Joined = await new Promise((resolve) => {
      client1.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    console.log(`✓ Client 1 joined room as ${c1Joined.role}`);
    if (c1Joined.role !== 'initiator') throw new Error('Client 1 expected initiator');

    // Client 2 (Joiner with tokenB)
    const client2 = new WebSocket(WS_URL);
    await new Promise((resolve) => client2.on('open', resolve));
    console.log('✓ Client 2 connected');

    const p1NotifiedPromise = new Promise((resolve) => {
      client1.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'peer-joined') resolve(msg);
      });
    });

    client2.send(JSON.stringify({ type: 'join-room', room: testRoom, peerToken: tokenB }));

    const c2Joined = await new Promise((resolve) => {
      client2.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    console.log(`✓ Client 2 joined room as ${c2Joined.role}`);
    if (c2Joined.role !== 'joiner') throw new Error('Client 2 expected joiner');
    await p1NotifiedPromise;
    console.log('✓ Client 1 received peer-joined notification');

    // Test SDP Offer Relay
    const offerPromise = new Promise((resolve) => {
      client2.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'offer') resolve(msg);
      });
    });

    client1.send(JSON.stringify({ type: 'offer', offer: { type: 'offer', sdp: 'fake-sdp-offer' } }));
    const receivedOffer = await offerPromise;
    console.log('✓ SDP Offer relayed successfully to Client 2:', receivedOffer.offer.sdp);

    // Test SDP Answer Relay
    const answerPromise = new Promise((resolve) => {
      client1.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'answer') resolve(msg);
      });
    });

    client2.send(JSON.stringify({ type: 'answer', answer: { type: 'answer', sdp: 'fake-sdp-answer' } }));
    const receivedAnswer = await answerPromise;
    console.log('✓ SDP Answer relayed successfully to Client 1:', receivedAnswer.answer.sdp);

    // Test Stable Role Preservation on Reconnect (Client 1 disconnects & reconnects with tokenA)
    client1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const client1Reconnect = new WebSocket(WS_URL);
    await new Promise((resolve) => client1Reconnect.on('open', resolve));

    client1Reconnect.send(JSON.stringify({ type: 'join-room', room: testRoom, peerToken: tokenA }));
    const c1Rejoined = await new Promise((resolve) => {
      client1Reconnect.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    console.log(`✓ Reconnecting Client 1 preserved role: ${c1Rejoined.role}`);
    if (c1Rejoined.role !== 'initiator') throw new Error('Reconnecting Client 1 failed to preserve initiator role');

    // Test Room Full (Client 3)
    const client3 = new WebSocket(WS_URL);
    await new Promise((resolve) => client3.on('open', resolve));
    client3.send(JSON.stringify({ type: 'join-room', room: testRoom, peerToken: 'tokenC' }));

    const c3Response = await new Promise((resolve) => {
      client3.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'room-full') resolve(msg);
      });
    });
    console.log(`✓ Client 3 rejected: Room full (${c3Response.room})`);

    // Clean up all connections to empty room
    client1Reconnect.close();
    client2.close();
    client3.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Test Empty Room Reset (New pair joins empty room)
    const freshClient = new WebSocket(WS_URL);
    await new Promise((resolve) => freshClient.on('open', resolve));
    freshClient.send(JSON.stringify({ type: 'join-room', room: testRoom, peerToken: 'tokenFresh' }));

    const freshJoined = await new Promise((resolve) => {
      freshClient.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    console.log(`✓ First peer in emptied room assigned role: ${freshJoined.role}`);
    if (freshJoined.role !== 'initiator') throw new Error('Empty room reset failed to assign initiator role');
    freshClient.close();

    console.log('\n🎉 ALL SIGNALING SERVER TESTS PASSED SUCCESSFULLY!\n');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  } finally {
    serverProc.kill();
  }
}

runTests();
