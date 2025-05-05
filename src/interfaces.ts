interface Question {
  question: string;
  answer: number;
  unit: string;
}

interface User {
  id: string;
  username: string;
  ready: boolean;
}

interface UsersList {
  [id: string]: User[];
}

export { Question, User, UsersList };
