import { createServer, get } from 'http';
import { Server } from 'socket.io';
import { app } from './app.ts';

const QUESTION_LIMIT = 7; // Limit of questions per room, can be changed later
const MAX_USERS_PER_ROOM = 10; // Maximum number of users per room, can be changed later
const MAX_USERNAME_LENGTH = 20; // Maximum length of username, can be changed later
const DEFAULT_USER_TOKENS = 200; // Default number of tokens for each user at the start of the game
const MINIM_USER_TOKENS = 25; // Minimum number of tokens for each user, prevents user from blocking the game by having 0 tokens
const INNER_RANKING_TIMEOUT = 5000; // Timeout for showing inner ranking after voting, can be changed later


import _questions from "./questions.json" with {type: "json"}
import type { Question, User, RoomsList, Response, VotedAnswer } from './interfaces.ts';

const PORT = process.env.PORT || 3001;

const questions: Question[] = _questions
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

// Generate random 5-digit id for new room
const generateRoomId = (): string => Math.floor(10000 + Math.random() * 90000).toString();

let usersList: RoomsList = {}

// Shuffle array (Fisher-Yates)
function shuffleArray<T>(array: T[]): T[] {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function findUser(roomId: string, userId: string): User | null {
  return usersList[roomId]?.users.find(user => user.id === userId) || null;
}

function isEveryoneReady(roomId: string): boolean {
  return usersList[roomId]?.users.every(user => user.ready) ?? false;
}

function addUserToRoom(roomId: string, user: User): void {
  if (!usersList[roomId]) {
    usersList[roomId] = {
      users: [],
      questionCounter: -1,
      questions: shuffleArray(_questions) // assign shuffled questions to the room
    };
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

  // Middleware to check if user is in a room and if the game has started
  socket.use(([event, ...args], next) => {
    if (
      ["send-answer", "start-voting", "confirm-votes", "get-voting-results", "get-player-rankings"].includes(event)
    ) {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        if (!userRoom || !usersList[userRoom]) {
          cb({ success: false, message: "No room found!" });
          return;
        }
        if (usersList[userRoom].questionCounter === -1) {
          cb({ success: false, message: "Game has not started yet!" });
          return;
        }
        if (usersList[userRoom].questionCounter >= QUESTION_LIMIT) {
          cb({ success: false, message: "Game has already ended!" });
          return;
        }
      }
    }
    next();
  });

  let userRoom: string = "";

  const getDefaultUser = (name: string): User => ({
    id: socket.id,
    username: name,
    ready: false,
    tokens: -1, // -1 means not set yet
    votedAnwsers: []
  });

  const getCurrentQuestion = (): Question => usersList[userRoom]?.questions[usersList[userRoom]?.questionCounter ?? 0];
  const getCurrentQuestionUnit = (): string => getCurrentQuestion().unit;

  const checkEndOfGame = () => usersList[userRoom].questionCounter >= QUESTION_LIMIT - 1;

  // ** Dołączanie do pokoju **
  socket.on("create-room", async (username: string, cb: (room: string, response: Response) => void) => {
    // Check if username is too long
    if (username.length > MAX_USERNAME_LENGTH) {
      console.log(`User with name ${username} tried to create a room but username is too long.`);
      cb("", { success: false, message: `Username cannot be longer than ${MAX_USERNAME_LENGTH} characters!` });
      return;
    }

    // Check if username is empty
    if (!username?.trim()) {
      console.log(`User with name ${username} tried to create a room but username is empty.`);
      cb("", { success: false, message: "Username cannot be empty!" });
      return;
    }

    userRoom = generateRoomId();

    socket.join(userRoom);
    
    console.log(`User ${socket.id} with name ${username} joined room ${userRoom}`);
    cb(userRoom, { success: true });
  
    addUserToRoom(userRoom, getDefaultUser(username));
  })

  socket.on("join-room", async (roomId: string, username: string, cb: (roomId: string, response: Response) => void) => {

    // Check if roomId doesn't exist or username is empty
    if (!usersList[roomId] || !username?.trim()) {
      cb(roomId, { success: false, message: "Invalid room ID or username!" });
      return;
    }

    // Check if room is already in progress
    if (usersList[roomId].questionCounter !== -1) {
      console.log(`Room ${roomId} is already in progress, cannot join.`);
      cb(roomId, { success: false, message: "Room is already in progress!" });
      return;
    }

    // Check if username already exists in the room
    if (usersList[roomId].users.some(user => user.username === username)) {
      console.log(`User with name ${username} already exists in room ${roomId}`);
      cb(roomId, { success: false, message: "Username already exists in this room!" });
      return;
    }

    // Check if room is full
    if (usersList[roomId].users.length >= MAX_USERS_PER_ROOM) {
      console.log(`Room ${roomId} is full, cannot join.`);
      cb(roomId, { success: false, message: "Room is full!" });
      return;
    }

    socket.join(roomId);
    console.log(`User ${socket.id} with name ${username} joined room ${roomId}`);

    userRoom = roomId;
    cb(roomId, { success: true });
    addUserToRoom(userRoom, getDefaultUser(username));
  })

  socket.on("user-ready", (cb: (response: Response) => void) => {
    const user = findUser(userRoom, socket.id)
    if (!user) {
      console.error(`User with id ${socket.id} not found in room ${userRoom}`);
      cb({ success: false, message: "User not found!" });
      return;
    }
    if (user.ready) {
      console.log(`User ${socket.id} is already ready.`);
      cb({ success: false, message: "You are already ready!" });
      return;
    }
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

        usersList[userRoom].questionCounter = 0; // setup for first question
      }
      cb({ success: true });
    }
  })

  socket.on("disconnect", () => {
    if (!userRoom) return

    // Może na odwrót
    io.to(userRoom).emit("user-disconnected", socket.id)
    removeUserFromRoom(userRoom, socket.id)

    // Zabezpieczenie przed odłączeniem w trakcie czekania
    if (isEveryoneReady(userRoom)) {
      io.to(userRoom).emit("all-users-ready")
    }

    if (usersList[userRoom]) {
      // Jeśli ktoś wyjdzie podczas odpowiadania lub głosowania, sprawdź czy wszyscy są "ready"
      // (czyli czy nie trzeba zakończyć etapu)
      const stageUsers = usersList[userRoom].users;

      // Odpowiadanie
      if (stageUsers.every(user => user.ready || typeof user.answer === "number")) {
        io.to(userRoom).emit("all-users-answered");
        stageUsers.forEach(user => user.ready = false);
      }

      // Głosowanie
      if (stageUsers.every(user => user.ready || (user.votedAnwsers && user.votedAnwsers.length > 0))) {
        io.to(userRoom).emit("all-users-voted");
        stageUsers.forEach(user => user.ready = false);

        // Przelicz tokeny i przejdź dalej, jeśli trzeba
        calculateTokens();

        setTimeout(() => {
          io.to(userRoom).emit("show-ranking");
        }, INNER_RANKING_TIMEOUT);

        setTimeout(() => {
          if (checkEndOfGame()) {
            io.to(userRoom).emit("end-of-game");
            return;
          }
          stageUsers.forEach(user => {
            user.answer = undefined;
            user.ready = false;
            user.votedAnwsers = [];
          });
          usersList[userRoom].questionCounter++;
          io.to(userRoom).emit("next-question");
        }, INNER_RANKING_TIMEOUT * 2);
      }

      // Wyświetlanie rankingu - jeśli ktoś wyjdzie, odśwież ranking
      io.to(userRoom).emit("update-players-list", stageUsers);
    }
  })

  // ** Questioning **
  socket.on("get-question", (qs: (question: string) => void) => {
    if (usersList[userRoom]?.questionCounter === -1) {
      console.error(`Game has not started yet in room ${userRoom}`);
      return;
    }
    qs(getCurrentQuestion().question);
  })

  socket.on("send-answer", (answer: string, cb: (response: Response)  => void) => {
    const user = findUser(userRoom, socket.id)
    if (user) {

      // Answer validation
      const answerNumber = Number(answer);
      if (isNaN(answerNumber)) {
        cb({ success: false, message: "Answer is not a number!"});
        return;
      }
      if (answerNumber < 0) {
        cb({ success: false, message: "Answer cannot be negative!"});
        return;
      }

      console.log(`User ${user.username} answered: ${answer}`);

      // Save answer
      user.ready = true;
      user.answer = answerNumber;
      cb({ success: true }); // Poprawna odpowiedź
      if (isEveryoneReady(userRoom)) {
        console.log(`Everyone in room ${userRoom} has answered!`);

        io.to(userRoom).emit("all-users-answered")

        usersList[userRoom].users.forEach(user => {
          user.ready = false; // reset readiness for next question
        })
      }
    }
  })

  // ** Voting **
  socket.on("start-voting", (cb: (response: Response, answers: {id: string, answer: number}[], unit: string, tokens: number) => void) => {
    const userAnswers = usersList[userRoom].users
    .filter(user => typeof user.answer === "number")
    .map(user => ({id: user.id, answer: user.answer as number, unit: getCurrentQuestionUnit()}));
    
    const user = findUser(userRoom, socket.id);
    const unit = getCurrentQuestion().unit;

    if (!user) {
      console.error(`User with id ${socket.id} not found in room ${userRoom}`);
      cb({ success: false, message: "User not found!" }, [], unit, -1);
      return;
    }

    if (user.tokens === -1) {
      user.tokens = DEFAULT_USER_TOKENS;
    }
      
    cb({ success: true}, userAnswers, unit, user.tokens);
  })

  socket.on("confirm-votes", (votedAnwsers: VotedAnswer[], finalTokens: number, cb: (response: Response) => void) => {
    const user = findUser(userRoom, socket.id);
    if (user) {
      if (finalTokens > user.tokens) {
        cb({success: false, message: "Not enough tokens!"});
        return;
      }
      if (finalTokens < 0) {
        cb({success: false, message: "Invalid tokens!"});
        return;
      }

      if (finalTokens === user.tokens) {
        user.ready = true;
        cb({success: true});
      }

      user.votedAnwsers = votedAnwsers;
      console.log("User has voted for: ", user.votedAnwsers);

      user.ready = true;

      if (isEveryoneReady(userRoom)) {
        console.log(`Everyone in room ${userRoom} has voted!`);
        io.to(userRoom).emit("all-users-voted");

        usersList[userRoom].users.forEach(user => {
          user.ready = false; // reset readiness for next question/voting
        })

        calculateTokens();

        // Set timeouts ONCE per room after all users have voted
        setTimeout(() => {
          io.to(userRoom).emit("show-ranking");
        }, INNER_RANKING_TIMEOUT);


        setTimeout(() => {
          if (checkEndOfGame()) {
            console.log(`End of game in room ${userRoom}`);
            io.to(userRoom).emit("end-of-game");
            return;
          }

          usersList[userRoom].users.forEach(user => {
            user.answer = undefined; // Reset answer
            user.ready = false; // Reset readiness for next question
            user.votedAnwsers = []; // Reset voted answers
          });
          usersList[userRoom].questionCounter++;
          console.log(`Moving to next question in room ${userRoom}`);
          io.to(userRoom).emit("next-question");
        }, INNER_RANKING_TIMEOUT * 2);
      }
      
      cb({success: true});
      
    } else {
      cb({success: false, message: "User not found!"});
    }
  })

  socket.on("get-voting-results", (cb: (correctAnswer: number, closestAnswer: number | null, unit: string, tokens: number, allUsersTokens: number[]) => void) => {
    const user = findUser(userRoom, socket.id);
    const correctAnswer = usersList[userRoom].questions[usersList[userRoom].questionCounter].answer;
    if (!correctAnswer) {
      console.error("No question found for the current question counter.");
      return;
    }
    const closestAnswer = findClosestBelowAnswer(correctAnswer);
    const tokens = user?.tokens ?? 0;
    const allUsersTokens = usersList[userRoom].users.map(user => user.tokens);

    cb(correctAnswer, closestAnswer, getCurrentQuestionUnit(), tokens, allUsersTokens);

    console.log(`User ${user?.username} now has ${tokens} tokens after voting.`);
    // Removed setTimeouts from here
  })

  function calculateTokens() {
    const room = usersList[userRoom];
    if (!room) return;

    const questionIdx = room.questionCounter;
    const correctAnswer = room.questions[questionIdx].answer;

    // Find the closest answer (not exceeding correctAnswer if possible)
    const closest = findClosestBelowAnswer(correctAnswer);

    room.users.forEach(user => {
      user.votedAnwsers.forEach(votedAnswer => {
        // Find the user whose answer was voted on
        const votedUser = room.users.find(u => u.id === votedAnswer.id);
        if (!votedUser || typeof votedUser.answer !== "number") return;

        const votedValue = votedUser.answer as number;
        const votedTokens = votedAnswer.tokens;

        const distance = (correctAnswer - votedValue) / correctAnswer;
        if (votedValue === correctAnswer) {
          user.tokens += votedTokens * 2;
        } else if (votedValue === closest) {
          user.tokens += votedTokens * 1.5;
        } else if (distance > 0 && distance <= 0.25) {
          user.tokens += votedTokens;
        } else {
          user.tokens -= votedTokens;
        }

        if (user.tokens < MINIM_USER_TOKENS) {
          user.tokens = MINIM_USER_TOKENS; // Ensure minimum tokens
        }
      })
    })
  }

  function findClosestBelowAnswer(correctAnswer: number): number | null {
    const correct = Number(correctAnswer);
    const answers = usersList[userRoom]?.users
      .map(user => typeof user.answer === "number" ? user.answer as number : null)
      .filter((ans): ans is number => ans !== null && ans <= correct);

    if (!answers || answers.length === 0) {
      // If no answer is less than or equal to correct, return null
      return null;
    }

    return Math.max(...answers);
  }
  
  // socket.on("next-round", () => {
  //   usersList[userRoom].questionCounter++;
  // })

  socket.on("get-player-rankings", (cb: (rankings: {username: string, tokens: number}[]) => void) => {
    const rankings = usersList[userRoom]?.users
    .map(user => ({ username: user.username, tokens: user.tokens }))
    .sort((a, b) => b.tokens - a.tokens);

    cb(rankings || []);
  });

  // socket.on("start-new-game", (cb: (response: Response) => void) => {
  //   if (!userRoom || !usersList[userRoom]) {
  //     cb({ success: false, message: "No room found!" });
  //     return;
  //   }

  //   // Reset all users in the room
  //   usersList[userRoom].users.forEach(user => {
  //     user.ready = false;
  //     user.answer = undefined;
  //     user.tokens = DEFAULT_USER_TOKENS; // Reset tokens
  //     user.votedAnwsers = [];
  //   });

  //   usersList[userRoom].questionCounter = 0; // Reset question counter

  //   console.log(`Starting new game in room ${userRoom}`);
  //   io.to(userRoom).emit("new-game-started");

  //   cb({ success: true });
  // });
})

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});