interface Question {
  question: string;
  answer: number;
  unit: string;
}

interface User {
  id: string;
  username: string;
  ready: boolean;
  anwser?: number;
}

interface RoomsList {
  [id: string]: {
    "users": User[],
    "questionCounter": number
  };
}

export { Question, User, RoomsList };
