import { createServer, get } from 'http';
import { Server } from 'socket.io';
import { app } from './app.ts';

const QUESTION_LIMIT = 7; // Limit of questions per room, can be changed later

import _questions from "./questions.json" with {type: "json"}
import type { Question, User, RoomsList, Response, VotedAnswer } from './interfaces.ts';

const PORT = process.env.PORT || 3001;

const questions: Question[] = _questions
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

const DEFAULT_USER_TOKENS = 200;
const MINIM_USER_TOKENS = 25;

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
      questionCounter: 0,
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
        }, 5000);

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
        }, 10000);
      }

      // Wyświetlanie rankingu - jeśli ktoś wyjdzie, odśwież ranking
      io.to(userRoom).emit("update-players-list", stageUsers);
    }
  })

  // ** Odpytywanie **
  socket.on("get-question", (qs: (question: string) => void) => {
    // const questionCounter = usersList[userRoom]?.questionCounter ?? 0;
    // qs(questions[questionCounter].question);
    qs(getCurrentQuestion().question);
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

        // if (usersList[userRoom].questionCounter >= questions.length) {
        //   io.to(userRoom).emit("end-of-questions");
        //   console.log(`End of questions in room ${userRoom}`);
        // }
        usersList[userRoom].users.forEach(user => {
          user.ready = false; // reset readiness for next question
        })
      }
    }
  })

  // ** Głosowanie **
  socket.on("start-voting", (cb: (answers: {id: string, answer: number}[], unit: string, tokens: number) => void) => {
    const userAnswers = usersList[userRoom].users
    .filter(user => typeof user.answer === "number")
    .map(user => ({id: user.id, answer: user.answer as number, unit: getCurrentQuestionUnit()}));
    
    const user = findUser(userRoom, socket.id);
    const unit = getCurrentQuestion().unit;
    if (user) {
      if (user.tokens === -1) {
        user.tokens = DEFAULT_USER_TOKENS;
      }
      
      cb(userAnswers, unit, user.tokens);
    } else {
      cb([], unit, -1); // Użytkownik nie znaleziony
    }
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
        }, 5000);


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
        }, 10000);
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