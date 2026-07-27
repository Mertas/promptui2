// Server configuration from environment variables
import 'dotenv/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = parseInt(process.env.PORT || '3042', 10);
export const DB_PATH = process.env.DB_PATH || resolve(__dirname, '..', '..', 'data', 'promptui.db');
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
export const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);
export const FS_ROOT = process.env.FS_ROOT || resolve(__dirname, '..', '..', 'workspace');
