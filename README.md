<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/c17d0ed6-384f-4fa6-a51c-5e314dc496dd

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Deploy to Vercel

Sigue estos pasos para publicar tu aplicación en Vercel:

1. **Inicia sesión en Vercel** (si aún no lo has hecho):
   `vercel login`

2. **Despliega el proyecto**:
   `vercel`

   - Sigue las instrucciones en la terminal (puedes pulsar Enter para aceptar los valores por defecto).

3. **Configura tu API Key**:
   Para que el análisis sintáctico funcione en la web, añade tu clave de API en Vercel:
   `vercel env add GEMINI_API_KEY`

4. **Despliegue final (Producción)**:
   `vercel --prod`

¡Tu aplicación estará lista en una URL de Vercel!
