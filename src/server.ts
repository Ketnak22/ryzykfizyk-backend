import { createServer } from 'http';
import { Server } from 'socket.io';
import { app } from './app.ts';

import _questions from "./questions.json" with {type: "json"}
import type { Question, User, UsersList } from './interfaces.ts';

const PORT = process.env.PORT || 3001;

const questions: Question[] = _questions
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// Generate random 5-digit id for new room
const generateRoomId = (): string => Math.floor(10000 + Math.random() * 90000).toString();

let usersList: UsersList = {}

function findUser(roomId: string, userId: string): User | null {
  return usersList[roomId]?.find(user => user.id === userId) || null;
}

function isEveryoneReady(roomId: string): boolean {
  return usersList[roomId]?.every(user => user.ready) ?? false;
}

function addUserToRoom(roomId: string, user: User): void {
  if (!usersList[roomId]) {
    usersList[roomId] = [];
  }
  usersList[roomId].push(user);
  io.to(roomId).emit("update-players-list", usersList[roomId]);
}

function removeUserFromRoom(roomId: string, userId: string): void {
  if (!usersList[roomId]) return;
  usersList[roomId] = usersList[roomId].filter(user => user.id !== userId);
  io.to(roomId).emit("update-players-list", usersList[roomId]);

  if (usersList[roomId].length === 0) {
    delete usersList[roomId]; // clean up empty room
  }
}

io.on("connection", socket => {
  let userRoom: string = "";

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
        // TODO: Odliczanie/przejście do gry
    }
    }
  })

  socket.on("disconnect", () => {
    if (!userRoom) return

    // Może na odwrót
    io.to(userRoom).emit("user-disconnected", socket.id)

    removeUserFromRoom(userRoom, socket.id)

    if (isEveryoneReady(userRoom)) {
      io.to(userRoom).emit("all-users-ready")
    }
  })
  
  socket.on("get-questions", (cb: (qs: Question[]) => void) => {
    cb(questions);
  })

})

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});