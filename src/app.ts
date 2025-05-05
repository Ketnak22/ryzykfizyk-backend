import express from 'express';
import routes from './routes/index.ts';

export const app = express();

app.use(express.json());
app.use('/api', routes);
