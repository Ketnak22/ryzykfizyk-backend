import { createServer } from 'http';
import { Server } from 'socket.io';
import { app } from './app.ts';

import _questions from "./questions.json" with {type: "json"}
import type { Question, User, RoomsList } from './interfaces.ts';

const PORT = process.env.PORT || 3001;

const questions: Question[] = _questions
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

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

  // ** Dołączanie do pokoju **
  socket.on("create-room", async (username: string, cb: (room: string) => void) => {
    userRoom = generateRoomId();

    socket.join(userRoom)
    
    console.log(`User ${socket.id} with name ${username} joined room ${userRoom}`)

    cb(userRoom)
  
    addUserToRoom(userRoom, {id: socket.id, username: username, ready: false})
  })

  socket.on("join-room", async (roomId: string, username: string, cb: (roomId: string, success: boolean) => void) => {

    // Check if roomId doesn't exist or username is empty
    if (!usersList[roomId] || !username?.trim()) {
      cb(roomId, false);
      return;
    }

    socket.join(roomId)
    console.log(`User ${socket.id} with name ${username} joined room ${roomId}`)

    userRoom = roomId
    cb(roomId, true);
    addUserToRoom(userRoom, {id: socket.id, username: username, ready: false})
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
    qs(questions[currentQuestion++].question);
  })

  socket.on("send-answer", (answer: number, cb: ()  => void) => {
    const user = findUser(userRoom, socket.id)
    if (user) {
      console.log(`User ${user.username} answered: ${answer}`);
      user.ready = true;
      user.anwser = answer;
      cb();
      if (isEveryoneReady(userRoom)) {
        console.log(`Everyone in room ${userRoom} has answered!`);
        // io.to(userRoom).emit("receive-user-answers", {id: socket.id, answer: answer})
        io.to(userRoom).emit("all-users-answered")
        
      }
      // socket.to(userRoom).emit("receive-answer", {id: socket.id, answer: answer})
    }
  })

  socket.on("get-user-answers", (cb: (answers: {id: string, answer: number}[]) => void) => {
    const userAnswers = usersList[userRoom].users
      .filter(user => typeof user.anwser === "number")
      .map(user => ({id: user.id, answer: user.anwser as number}));
    cb(userAnswers);
  })
  
})

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});