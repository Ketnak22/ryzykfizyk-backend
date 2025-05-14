import { createServer } from 'http';
import { Server } from 'socket.io';
import { app } from './app.ts';

import _questions from "./questions.json" with {type: "json"}
import type { Question, User, RoomsList } from './interfaces.ts';

const PORT = process.env.PORT || 3001;

const questions: Question[] = _questions
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

const DEFAULT_USER_TOKENS = 2;

// Generate random 5-digit id for new room
const generateRoomId = (): string => Math.floor(10000 + Math.random() * 90000).toString();

let usersList: RoomsList = {}

function findUser(roomId: string, userId: string): User | null {
  return usersList[roomId]?.users.find(user => user.id === userId) || null;
}

function isEveryoneReady(roomId: string): boolean {
  return usersList[roomId]?.users.every(user => user.ready) ?? false;
}

function addUserToRoom(roomId: string, user: User): void {
  if (!usersList[roomId]) {
    usersList[roomId] = { users: [], questionCounter: 0 };
  }
  usersList[roomId].users.push(user);
  io.to(roomId).emit("update-players-list", usersList[roomId].users);
}

function removeUserFromRoom(roomId: string, userId: string): void {
  if (!usersList[roomId]) return;
  usersList[roomId].users = usersList[roomId].users.filter(user => user.id !== userId);
  io.to(roomId).emit("update-players-list", usersList[roomId]);

  if (usersList[roomId].users.length === 0) {
    delete usersList[roomId]; // remove room from list
    console.log(`Room ${roomId} is empty and has been removed.`);
  }
}

io.on("connection", socket => {
  let userRoom: string = "";
  let currentQuestion = 0;

  const getDefaultUser = (name: string): User => ({
    id: socket.id,
    username: name,
    ready: false,
    tokens: 0,
    votedAnwsers: []
  });

  // ** Dołączanie do pokoju **
  socket.on("create-room", async (username: string, cb: (room: string) => void) => {
    userRoom = generateRoomId();

    socket.join(userRoom);
    
    console.log(`User ${socket.id} with name ${username} joined room ${userRoom}`);

    cb(userRoom);
  
    addUserToRoom(userRoom, getDefaultUser(username));
  })

  socket.on("join-room", async (roomId: string, username: string, cb: (roomId: string, success: boolean) => void) => {

    // Check if roomId doesn't exist or username is empty
    if (!usersList[roomId] || !username?.trim()) {
      cb(roomId, false);
      return;
    }

    socket.join(roomId);
    console.log(`User ${socket.id} with name ${username} joined room ${roomId}`);

    userRoom = roomId;
    cb(roomId, true);
    addUserToRoom(userRoom, getDefaultUser(username));
  })

  socket.on("user-ready", () => {
    const user = findUser(userRoom, socket.id)
    if (user) {
      user.ready = true
      console.log(`User ${socket.id} set to ready`);
      socket.to(userRoom).emit("user-ready-update", socket.id)

      if (isEveryoneReady(userRoom)) {
        console.log(`Everyone in room ${userRoom} is ready!`);
        io.to(userRoom).emit("all-users-ready")

        usersList[userRoom].users.forEach(user => {
          user.ready = false; // reset readiness for questions
        });
    }
    }
  })

  // TODO: Zabezpieczyć przed odłączeniem w trakcie odpowiadania, głosowania 
  socket.on("disconnect", () => {
    if (!userRoom) return

    // Może na odwrót
    io.to(userRoom).emit("user-disconnected", socket.id)
    removeUserFromRoom(userRoom, socket.id)

    // Zabezpieczenie przed odłączeniem w trakcie czekania
    if (isEveryoneReady(userRoom)) {
      io.to(userRoom).emit("all-users-ready")
    }
  })

  // ** Odpytywanie **
  socket.on("get-question", (qs: (question: string) => void) => {
    const questionCounter = usersList[userRoom]?.questionCounter ?? 0;
    qs(questions[questionCounter].question);
  })

  socket.on("send-answer", (answer: string, cb: (successfull: boolean)  => void) => {
    const user = findUser(userRoom, socket.id)
    if (user) {

      // Walidacja odpowiedzi
      const answerNumber = Number(answer);
      if (isNaN(answerNumber)) {
        cb(false); // Niepoprawna odpowiedź
        return;
      }
      console.log(`User ${user.username} answered: ${answer}`);

      // Zapisanie odpowiedzi
      user.ready = true;
      user.answer = answerNumber;
      cb(true); // Poprawna odpowiedź
      if (isEveryoneReady(userRoom)) {
        console.log(`Everyone in room ${userRoom} has answered!`);

        io.to(userRoom).emit("all-users-answered")

        usersList[userRoom].questionCounter++;
      }
    }
  })

  socket.on("start-voting", (cb: (answers: {id: string, answer: number}[], tokens: number) => void) => {
    const userAnswers = usersList[userRoom].users
    .filter(user => typeof user.answer === "number")
    .map(user => ({id: user.id, answer: user.answer as number, unit: questions[currentQuestion]?.unit ?? ""}));
    
    const user = findUser(userRoom, socket.id);
    if (user) {
      user.tokens = DEFAULT_USER_TOKENS;
      cb(userAnswers, user.tokens);
    } else {
      cb([], -1); // Użytkownik nie znaleziony
    }
  })
  
  socket.on("clear-votes", (cb: (succesfull: boolean, defaultUserTokens: number) => void) => {
    const user = findUser(userRoom, socket.id);
    if (user) {
      user.votedAnwsers = [];
      cb(true, DEFAULT_USER_TOKENS);
    } else {
      cb(false, DEFAULT_USER_TOKENS); // Użytkownik nie znaleziony
    }
  });

  socket.on("vote", (answerId: string, cb: (succesfull: boolean) => void) => {
    const user = findUser(userRoom, socket.id);
    if (user) {
      if (user.votedAnwsers.includes(answerId)) {
        cb(false); // Już głosował na tę odpowiedź
        return;
      }

      user.votedAnwsers.push(answerId);
      user.tokens--;
      cb(true);
    } else {
      cb(false); // Użytkownik nie znaleziony
    }
  })
})

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});