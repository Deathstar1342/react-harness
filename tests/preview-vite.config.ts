import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
if(!process.env.M35_UI_OUTPUT||!path.isAbsolute(process.env.M35_UI_OUTPUT))throw new Error('Explicit external preview fixture output required');
export default defineConfig({root:path.join(import.meta.dirname,'fixtures/preview'),plugins:[react()],build:{outDir:process.env.M35_UI_OUTPUT,emptyOutDir:true}});
