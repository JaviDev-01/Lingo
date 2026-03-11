import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const SYSTEM_INSTRUCTION = `
Eres un experto lingüista especializado en la Nueva Gramática de la Lengua Española (NGLE). 
Realiza un análisis sintáctico profesional por NIVELES.

REGLAS NGLE:
1. SPrep: Preposición es NÚCLEO (E), lo demás es TÉRMINO (T).
2. Sujeto Tácito: Inclúyelo como la PRIMERA palabra entre paréntesis (ej: "(Yo)") si existe.
3. Complementos: CD, CI, CRég, Atributo, CPred, CC, CAL, Medida Argumental.

APRENDIZAJE Y MEJORA CONTINUA:
Se te proporcionará un historial de tus errores previos. DEBES revisarlos antes de cada análisis para no repetir los mismos fallos y ajustar tu confianza. Si la frase actual es similar a un error corregido, aplica el aprendizaje.

CÁLCULO DE CONFIANZA (PROFESIONAL):
La confianza debe ser un número entero entre 0 y 100 que refleje la complejidad lingüística.
Réstale puntos si:
- Hay ambigüedad sintáctica.
- La estructura es recursiva o muy larga.
- No estás seguro de la función de un pronombre "se".
- La frase se parece a un error que cometiste antes.
Si la frase es simple y clara, devuelve 100.
IMPORTANTE: Devuelve un número entero (ej: 95, no 0.95).

FORMATO:
Devuelve un JSON estructurado según el esquema proporcionado. 
Cada palabra tiene "niveles" con "etiqueta" y "ancho_grupo".
`;

export async function analyzeSentence(sentence: string, context?: string) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  const prompt = context 
    ? `HISTORIAL DE APRENDIZAJE (Tus errores pasados):\n${context}\n\nTAREA: Analiza la siguiente frase aplicando lo aprendido y calculando una confianza real: "${sentence}"`
    : `Analiza la siguiente frase y calcula una confianza real basada en su complejidad: "${sentence}"`;

  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              tipo_global: { type: Type.STRING },
              confianza: { type: Type.NUMBER },
              palabras: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    texto: { type: Type.STRING },
                    niveles: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          etiqueta: { type: Type.STRING },
                          ancho_grupo: { type: Type.NUMBER }
                        },
                        required: ["etiqueta", "ancho_grupo"]
                      }
                    }
                  },
                  required: ["texto", "niveles"]
                }
              },
              notas_ngle: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["tipo_global", "confianza", "palabras", "notas_ngle"]
          }
        }
      });

      const result = JSON.parse(response.text);
      return {
        ...result,
        usage: response.usageMetadata
      };
    } catch (error: any) {
      lastError = error;
      console.error(`Attempt ${attempt + 1} failed:`, error);
      
      // If it's a transient error (like the one reported), wait and retry
      const isTransient = error.message?.includes('xhr error') || 
                          error.message?.includes('Rpc failed') ||
                          error.status === 'UNAVAILABLE' ||
                          error.code === 500;
      
      if (isTransient && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}
