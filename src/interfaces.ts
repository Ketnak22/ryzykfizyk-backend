interface Question {
  question: string;
  answer: number;
  unit: string;
}

interface VotedAnswer {
  id: string;
  tokens: number;
}

interface User {
  id: string;
  username: string;
  
  ready: boolean;
  answer?: number;

  tokens: number;
  votedAnwsers: VotedAnswer[];
}

interface RoomsList {
  [id: string]: {
    users: User[];
    questionCounter: number;
  };
}

interface Response {
  success: boolean;
  message?: string;
}

export { Question, User, RoomsList, Response, VotedAnswer };
