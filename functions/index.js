"use strict";

const crypto = require("crypto");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");

admin.initializeApp();
setGlobalOptions({ region: "asia-southeast1", maxInstances: 10 });

const db = admin.database();
const ALLOWED_DICE = [4, 6, 8, 10, 12, 20];
const OPS = new Set(["+", "-", "*", "/", "(", ")"]);

function cleanRoomName(roomName) {
  const value = String(roomName || "").trim();
  if (!value || value.length > 40) throw new HttpsError("invalid-argument", "Room name is required.");
  if (!/^[a-zA-Z0-9 _-]+$/.test(value)) {
    throw new HttpsError("invalid-argument", "Room name can only use letters, numbers, spaces, underscores, and dashes.");
  }
  return value;
}

function cleanPlayerName(playerName) {
  const value = String(playerName || "Warrior").trim().slice(0, 24);
  return value || "Warrior";
}

function rollDie(sides) {
  if (!ALLOWED_DICE.includes(sides)) throw new HttpsError("internal", `Invalid die: d${sides}`);
  return crypto.randomInt(1, sides + 1);
}

function sortDice(dice) {
  return dice.sort((a, b) => a.v - b.v || a.s - b.s);
}

function createStartingDice() {
  return sortDice(ALLOWED_DICE.map(s => ({ s, v: rollDie(s) })));
}

function chooseStarter(p1D, p2D) {
  for (let i = 0; i < ALLOWED_DICE.length; i++) {
    if (p1D[i].v < p2D[i].v) return 1;
    if (p2D[i].v < p1D[i].v) return 2;
  }
  return crypto.randomInt(1, 3);
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function verifyPlayer(roomName, playerNum, playerToken) {
  if (playerNum !== 1 && playerNum !== 2) {
    throw new HttpsError("invalid-argument", "Invalid player number.");
  }

  const secretSnap = await db.ref(`roomSecrets/${roomName}/p${playerNum}`).get();
  const expectedHash = secretSnap.val();
  if (!expectedHash || expectedHash !== hashToken(playerToken)) {
    throw new HttpsError("permission-denied", "You are not a player in this room.");
  }
}

function requireTurn(room, playerNum) {
  if (!room || room.winner) throw new HttpsError("failed-precondition", "This match is already over.");
  if (room.count < 2) throw new HttpsError("failed-precondition", "Waiting for another player.");
  if (room.turn !== playerNum) throw new HttpsError("failed-precondition", "It is not your turn.");
}

function getDiceLists(room, playerNum) {
  const myKey = playerNum === 1 ? "p1D" : "p2D";
  const opKey = playerNum === 1 ? "p2D" : "p1D";
  const myD = Array.isArray(room[myKey]) ? [...room[myKey]] : [];
  const opD = Array.isArray(room[opKey]) ? [...room[opKey]] : [];
  return { myKey, opKey, myD, opD };
}

function validIndex(list, idx) {
  return Number.isInteger(idx) && idx >= 0 && idx < list.length;
}

function buildPublicRoom({ p1D, p2D, starter, p1Name }) {
  return {
    p1D,
    p2D,
    turn: starter,
    chip: starter,
    count: 1,
    p1Name,
    p2Name: "Waiting...",
    p1S: [],
    p2S: [],
    p1T: null,
    p2T: null,
    log: `${p1Name} created the arena.`,
    createdAt: admin.database.ServerValue.TIMESTAMP
  };
}

exports.createRoom = onCall(async request => {
  const roomName = cleanRoomName(request.data.roomName);
  const playerName = cleanPlayerName(request.data.playerName);
  const roomRef = db.ref(`rooms/${roomName}`);
  const secretRef = db.ref(`roomSecrets/${roomName}`);
  const playerToken = makeToken();
  const p1D = createStartingDice();
  const p2D = createStartingDice();
  const starter = chooseStarter(p1D, p2D);

  let created = false;
  await roomRef.transaction(current => {
    if (current && !current.winner) return;
    created = true;
    return buildPublicRoom({ p1D, p2D, starter, p1Name: playerName });
  });

  if (!created) throw new HttpsError("already-exists", "That arena already exists.");
  await secretRef.set({ p1: hashToken(playerToken) });
  return { playerNum: 1, playerToken };
});

exports.joinRoom = onCall(async request => {
  const roomName = cleanRoomName(request.data.roomName);
  const playerName = cleanPlayerName(request.data.playerName);
  const playerToken = makeToken();
  const roomRef = db.ref(`rooms/${roomName}`);

  let joined = false;
  await roomRef.transaction(room => {
    if (!room) throw new HttpsError("not-found", "That arena does not exist.");
    if (room.winner) throw new HttpsError("failed-precondition", "That arena is already finished.");
    if (room.count >= 2) throw new HttpsError("failed-precondition", "That arena is full.");
    joined = true;
    return {
      ...room,
      count: 2,
      p2Name: playerName,
      log: `${playerName} joined the arena.`
    };
  });

  if (!joined) throw new HttpsError("failed-precondition", "Could not join that arena.");
  await db.ref(`roomSecrets/${roomName}/p2`).set(hashToken(playerToken));
  return { playerNum: 2, playerToken };
});

exports.performStrengthAttack = onCall(async request => {
  const roomName = cleanRoomName(request.data.roomName);
  const playerNum = Number(request.data.playerNum);
  const attackerIndex = Number(request.data.attackerIndex);
  const targetIndex = Number(request.data.targetIndex);
  await verifyPlayer(roomName, playerNum, request.data.playerToken);

  const roomRef = db.ref(`rooms/${roomName}`);
  let result;
  await roomRef.transaction(room => {
    requireTurn(room, playerNum);
    const { myKey, opKey, myD, opD } = getDiceLists(room, playerNum);
    if (!validIndex(myD, attackerIndex) || !validIndex(opD, targetIndex)) {
      throw new HttpsError("invalid-argument", "Invalid dice selection.");
    }

    const atk = myD[attackerIndex];
    const def = opD[targetIndex];
    if (atk.v < def.v) {
      throw new HttpsError("failed-precondition", `Strength too low: ${atk.v} < ${def.v}.`);
    }

    opD.splice(targetIndex, 1);
    if (opD.length === 0) {
      result = { winner: playerNum };
      return {
        ...room,
        [opKey]: opD,
        winner: playerNum,
        p1S: [],
        p2S: [],
        p1T: null,
        p2T: null,
        log: `${playerNum === 1 ? room.p1Name : room.p2Name} used Strength Attack! ${atk.v} >= ${def.v}`
      };
    }

    myD[attackerIndex] = { ...atk, v: rollDie(atk.s) };
    result = { winner: null };
    return {
      ...room,
      [myKey]: sortDice(myD),
      [opKey]: opD,
      turn: playerNum === 1 ? 2 : 1,
      p1S: [],
      p2S: [],
      p1T: null,
      p2T: null,
      log: `${playerNum === 1 ? room.p1Name : room.p2Name} used Strength Attack! ${atk.v} >= ${def.v}`
    };
  });

  return result || { winner: null };
});

exports.performMindAttack = onCall(async request => {
  const roomName = cleanRoomName(request.data.roomName);
  const playerNum = Number(request.data.playerNum);
  const targetIndex = Number(request.data.targetIndex);
  const equationItems = Array.isArray(request.data.equationItems) ? request.data.equationItems : [];
  await verifyPlayer(roomName, playerNum, request.data.playerToken);

  const roomRef = db.ref(`rooms/${roomName}`);
  let result;
  await roomRef.transaction(room => {
    requireTurn(room, playerNum);
    const { myKey, opKey, myD, opD } = getDiceLists(room, playerNum);
    if (!validIndex(opD, targetIndex)) throw new HttpsError("invalid-argument", "Invalid target die.");

    const usedIndices = [];
    const expression = equationItems.map(item => {
      if (item && item.type === "die") {
        const idx = Number(item.dieIdx);
        if (!validIndex(myD, idx)) throw new HttpsError("invalid-argument", "Invalid equation die.");
        usedIndices.push(idx);
        return { type: "num", value: myD[idx].v };
      }
      if (item && item.type === "op" && OPS.has(item.value)) return { type: "op", value: item.value };
      throw new HttpsError("invalid-argument", "Invalid equation item.");
    });

    const uniqueUsed = [...new Set(usedIndices)];
    if (uniqueUsed.length !== usedIndices.length) throw new HttpsError("invalid-argument", "You cannot use the same die twice.");
    if (uniqueUsed.length < 2) throw new HttpsError("failed-precondition", "Use at least 2 dice in the equation.");

    const equationResult = evaluateExpression(expression);
    const def = opD[targetIndex];
    if (Math.round(equationResult * 1000) / 1000 !== def.v) {
      throw new HttpsError("failed-precondition", `${equationResult} does not equal ${def.v}.`);
    }

    opD.splice(targetIndex, 1);
    if (opD.length === 0) {
      result = { winner: playerNum };
      return {
        ...room,
        [opKey]: opD,
        winner: playerNum,
        p1S: [],
        p2S: [],
        p1T: null,
        p2T: null,
        log: `${playerNum === 1 ? room.p1Name : room.p2Name} used Mind Attack!`
      };
    }

    uniqueUsed.forEach(idx => {
      myD[idx] = { ...myD[idx], v: rollDie(myD[idx].s) };
    });

    result = { winner: null };
    return {
      ...room,
      [myKey]: sortDice(myD),
      [opKey]: opD,
      turn: playerNum === 1 ? 2 : 1,
      p1S: [],
      p2S: [],
      p1T: null,
      p2T: null,
      log: `${playerNum === 1 ? room.p1Name : room.p2Name} used Mind Attack!`
    };
  });

  return result || { winner: null };
});

exports.passTurn = onCall(async request => {
  const roomName = cleanRoomName(request.data.roomName);
  const playerNum = Number(request.data.playerNum);
  await verifyPlayer(roomName, playerNum, request.data.playerToken);

  await db.ref(`rooms/${roomName}`).transaction(room => {
    requireTurn(room, playerNum);
    return {
      ...room,
      turn: playerNum === 1 ? 2 : 1,
      p1S: [],
      p2S: [],
      p1T: null,
      p2T: null,
      log: `${playerNum === 1 ? room.p1Name : room.p2Name} passed their turn.`
    };
  });

  return { ok: true };
});

exports.surrender = onCall(async request => {
  const roomName = cleanRoomName(request.data.roomName);
  const playerNum = Number(request.data.playerNum);
  await verifyPlayer(roomName, playerNum, request.data.playerToken);

  await db.ref(`rooms/${roomName}`).transaction(room => {
    if (!room || room.winner) throw new HttpsError("failed-precondition", "This match is already over.");
    const winner = playerNum === 1 ? 2 : 1;
    return {
      ...room,
      winner,
      log: `${playerNum === 1 ? room.p1Name : room.p2Name} surrendered.`
    };
  });

  return { ok: true };
});

function evaluateExpression(tokens) {
  const output = [];
  const ops = [];
  const precedence = { "+": 1, "-": 1, "*": 2, "/": 2 };

  for (const token of tokens) {
    if (token.type === "num") {
      output.push(token);
    } else if (token.value === "(") {
      ops.push(token.value);
    } else if (token.value === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") output.push({ type: "op", value: ops.pop() });
      if (ops.pop() !== "(") throw new HttpsError("invalid-argument", "Invalid equation.");
    } else if (precedence[token.value]) {
      while (ops.length && precedence[ops[ops.length - 1]] >= precedence[token.value]) {
        output.push({ type: "op", value: ops.pop() });
      }
      ops.push(token.value);
    }
  }

  while (ops.length) {
    const op = ops.pop();
    if (op === "(") throw new HttpsError("invalid-argument", "Invalid equation.");
    output.push({ type: "op", value: op });
  }

  const stack = [];
  for (const token of output) {
    if (token.type === "num") {
      stack.push(token.value);
      continue;
    }

    if (stack.length < 2) throw new HttpsError("invalid-argument", "Invalid equation.");
    const b = stack.pop();
    const a = stack.pop();
    if (token.value === "+") stack.push(a + b);
    if (token.value === "-") stack.push(a - b);
    if (token.value === "*") stack.push(a * b);
    if (token.value === "/") {
      if (b === 0) throw new HttpsError("invalid-argument", "Cannot divide by zero.");
      stack.push(a / b);
    }
  }

  if (stack.length !== 1 || !Number.isFinite(stack[0])) {
    throw new HttpsError("invalid-argument", "Invalid equation.");
  }

  return stack[0];
}
