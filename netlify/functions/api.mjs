import { handle } from '../../lib/api.mjs';

export default async (req) => handle(req);

export const config = { path: '/api/*' };
