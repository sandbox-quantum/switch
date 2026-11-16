import { config } from 'zod';

// Zod compiles its object parsers with `new Function` when it can, and finds
// out by trying. The window's Content-Security-Policy refuses that, so each
// try is a reported violation; told up front, Zod uses its interpreter.
// Imported first by main.tsx, before any module can parse.
config({ jitless: true });
