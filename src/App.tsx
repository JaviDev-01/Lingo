import React, { useState, useEffect, Component } from 'react';
import { Search, BookOpen, Info, AlertCircle, Loader2, Sparkles, ThumbsUp, ThumbsDown, Send, CheckCircle2, Zap, History, LogOut, LogIn, ChevronDown, ChevronUp, Share2, Download, Trash2, ExternalLink, Github, Twitter, Mail, X, ChevronRight, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { analyzeSentence } from './services/geminiService';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, serverTimestamp, query, where, getDocs, orderBy, limit, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

const TOKEN_LIMIT = 1000000; // Aumentado a 1.000.000 según preferencia del usuario

class ErrorBoundary extends Component<any, any> {
  state = { hasError: false, error: null };
  
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let message = "Algo salió mal. Por favor, recarga la página.";
      try {
        const parsed = JSON.parse((this.state.error as any).message);
        if (parsed.error && parsed.error.includes("insufficient permissions")) {
          message = "No tienes permisos para acceder a estos datos. Asegúrate de haber iniciado sesión correctamente.";
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] p-4">
          <div className="modern-card bg-white max-w-md w-full text-center space-y-6">
            <div className="bg-red-500 text-white p-6 -mx-6 -mt-6 mb-6 rounded-t-2xl">
              <AlertCircle size={48} className="mx-auto mb-2" />
              <h2 className="text-2xl font-bold uppercase tracking-tight">Error Crítico</h2>
            </div>
            <p className="font-medium text-slate-600">{message}</p>
            <button 
              onClick={() => window.location.reload()}
              className="modern-button w-full"
            >
              Recargar Aplicación
            </button>
          </div>
        </div>
      );
    }

    return (this as any).props.children;
  }
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth();

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface AnalysisLevel {
  etiqueta: string;
  ancho_grupo: number;
}

interface AnalysisWord {
  texto: string;
  niveles: AnalysisLevel[];
}

interface AnalysisResult {
  tipo_global: string;
  confianza: number;
  palabras: AnalysisWord[];
  notas_ngle: string[];
  usage?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<'home' | 'history' | 'about'>('home');
  const [sentence, setSentence] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loadingStage, setLoadingStage] = useState('');
  const [estimatedTime] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [usedTokens, setUsedTokens] = useState(0);
  
  // Feedback states
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [showCorrectionInput, setShowCorrectionInput] = useState(false);
  const [correction, setCorrection] = useState('');
  const [learningContext, setLearningContext] = useState('');

  const [history, setHistory] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        loadLearningContext();
        checkApiKey();
        loadHistory(u.uid);
        loadUserTokens(u.uid);
      } else {
        setHistory([]);
        setUsedTokens(0);
      }
    });
    return () => unsubscribe();
  }, []);

  const loadUserTokens = async (uid: string) => {
    try {
      const userDoc = await getDoc(doc(db, 'users', uid));
      if (userDoc.exists()) {
        setUsedTokens(userDoc.data().usedTokens || 0);
      } else {
        await setDoc(doc(db, 'users', uid), { usedTokens: 0 });
        setUsedTokens(0);
      }
    } catch (e) {
      console.error("Error loading tokens:", e);
    }
  };

  const updateTokens = async (uid: string, tokensToAdd: number) => {
    try {
      const userRef = doc(db, 'users', uid);
      const userDoc = await getDoc(userRef);
      const currentUsed = userDoc.exists() ? (userDoc.data().usedTokens || 0) : 0;
      const newTotal = currentUsed + tokensToAdd;
      await updateDoc(userRef, { usedTokens: newTotal });
      setUsedTokens(newTotal);
    } catch (e) {
      console.error("Error updating tokens:", e);
    }
  };

  const loadHistory = async (uid: string) => {
    setLoadingHistory(true);
    const path = 'history';
    try {
      const q = query(
        collection(db, path),
        where('userId', '==', uid),
        orderBy('timestamp', 'desc'),
        limit(20)
      );
      const snapshot = await getDocs(q);
      const historyData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setHistory(historyData);
    } catch (e) {
      handleFirestoreError(e, OperationType.GET, path);
    } finally {
      setLoadingHistory(false);
    }
  };

  const checkApiKey = async () => {
    if (window.aistudio) {
      const selected = await window.aistudio.hasSelectedApiKey();
      setHasApiKey(selected);
    }
  };

  const handleSelectKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login error:", err);
      setError("Error al iniciar sesión con Google.");
    }
  };

  const handleLogout = () => signOut(auth);

  const loadLearningContext = async () => {
    const path = 'feedback';
    try {
      // Cargar los últimos 10 errores para un aprendizaje más profundo
      const q = query(
        collection(db, path),
        where('isCorrect', '==', false),
        orderBy('timestamp', 'desc'),
        limit(10)
      );
      const snapshot = await getDocs(q);
      const context = snapshot.docs
        .map(doc => `ERROR PREVIO -> Frase: "${doc.data().sentence}" | Corrección esperada: ${doc.data().correction}`)
        .join('\n');
      setLearningContext(context);
    } catch (e) {
      handleFirestoreError(e, OperationType.GET, path);
    }
  };

  const handleAnalyze = async () => {
    if (!sentence.trim()) return;
    
    if (user && usedTokens >= TOKEN_LIMIT) {
      setError("Has alcanzado tu límite de tokens. Contacta con soporte para ampliarlo.");
      return;
    }

    setLoading(true);
    setError(null);
    setFeedbackSent(false);
    setShowCorrectionInput(false);
    setCorrection('');
    setProgress(0);
    setLoadingStage('Iniciando motor lingüístico...');

    // Progress stages simulation
    const stages = [
      { threshold: 20, label: 'Tokenizando oración...' },
      { threshold: 45, label: 'Analizando jerarquía sintáctica...' },
      { threshold: 70, label: 'Aplicando normativa NGLE...' },
      { threshold: 90, label: 'Validando estructura final...' }
    ];

    let currentStageIdx = 0;
    const startTime = Date.now();
    const duration = 3000; // 3 seconds estimation for Flash model
    
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const rawProgress = (elapsed / duration) * 100;
      const newProgress = Math.min(rawProgress, 95); 
      
      setProgress(newProgress);

      if (currentStageIdx < stages.length && newProgress >= stages[currentStageIdx].threshold) {
        setLoadingStage(stages[currentStageIdx].label);
        currentStageIdx++;
      }
    }, 50);
    
    try {
      const analysis = await analyzeSentence(sentence, learningContext);
      clearInterval(progressInterval);
      setLoadingStage('¡Análisis completado!');
      setProgress(100);
      setResult(analysis);

      // Update tokens if user is logged in
      if (user && analysis.usage) {
        await updateTokens(user.uid, analysis.usage.totalTokenCount);
      }
      
      // Save to history if user is logged in
      if (user) {
        const path = 'history';
        try {
          await addDoc(collection(db, path), {
            sentence,
            result: analysis,
            timestamp: serverTimestamp(),
            userId: user.uid
          });
          loadHistory(user.uid);
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, path);
        }
      }

      // Small delay for smooth transition
      setTimeout(() => {
        setResult(analysis);
        setLoading(false);
      }, 300);
    } catch (err) {
      clearInterval(progressInterval);
      setError('Hubo un error al analizar la frase. Por favor, inténtalo de nuevo.');
      console.error(err);
      setLoading(false);
    }
  };

  const sendFeedback = async (isCorrect: boolean, userCorrection?: string) => {
    if (!user || !result) return;

    const path = 'feedback';
    try {
      await addDoc(collection(db, path), {
        sentence,
        isCorrect,
        correction: userCorrection || '',
        timestamp: serverTimestamp(),
        userId: user.uid
      });
      setFeedbackSent(true);
      setShowCorrectionInput(false);
      if (!isCorrect) loadLearningContext(); // Refresh context if we just added a correction
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, path);
    }
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#F8FAFC] text-[#1E293B] font-sans antialiased">
      {/* Navigation Bar */}
      <nav className="app-header px-4 py-4">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div 
            className="flex items-center gap-2 cursor-pointer group" 
            onClick={() => setCurrentPage('home')}
          >
            <div className="bg-indigo-600 text-white p-1.5 rounded-lg font-bold text-xl leading-none transition-transform group-hover:scale-105">NG</div>
            <span className="font-bold tracking-tight text-xl hidden sm:inline">Expert</span>
          </div>

          <div className="flex items-center gap-8">
            <div className="hidden md:flex items-center gap-6">
              {['home', 'history', 'about'].map((page) => (
                <button
                  key={page}
                  onClick={() => setCurrentPage(page as any)}
                  className={`font-semibold text-sm tracking-tight transition-all hover:text-indigo-600 relative py-1 ${
                    currentPage === page ? 'text-indigo-600' : 'text-slate-500'
                  }`}
                >
                  {page === 'home' ? 'Inicio' : page === 'history' ? 'Historial' : 'Sobre NGLE'}
                  {currentPage === page && (
                    <motion.div layoutId="nav-underline" className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 rounded-full" />
                  )}
                </button>
              ))}
            </div>

            <div className="h-6 w-px bg-slate-200 hidden md:block" />

            {user ? (
              <div className="flex items-center gap-4">
                <div className="hidden sm:flex flex-col items-end">
                  <span className="font-bold text-sm leading-none">{user.displayName}</span>
                  <button onClick={handleLogout} className="text-[11px] font-medium text-slate-400 hover:text-indigo-600 transition-colors">Cerrar Sesión</button>
                </div>
                <img src={user.photoURL} alt="" className="w-9 h-9 rounded-full ring-2 ring-slate-100" />
              </div>
            ) : (
              <button 
                onClick={handleLogin}
                className="modern-button py-2 px-6 text-sm"
              >
                Iniciar Sesión
              </button>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-12">
        <AnimatePresence mode="wait">
          {currentPage === 'home' && (
            <motion.div
              key="home"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-12"
            >
              <header className="text-center space-y-6 py-12">
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-1.5 rounded-full font-semibold text-xs uppercase tracking-wider"
                >
                  <Sparkles size={14} /> Motor Lingüístico NGLE v2.5
                </motion.div>
                
                <h1 className="text-5xl md:text-7xl font-bold tracking-tight text-slate-900 leading-tight">
                  Análisis Sintáctico<br/>
                  <span className="text-indigo-600">Profesional</span>
                </h1>
                
                <p className="text-lg text-slate-500 max-w-2xl mx-auto leading-relaxed">
                  Desglosa cualquier oración con la precisión de un experto en la Nueva Gramática de la RAE utilizando inteligencia artificial avanzada.
                </p>

                {user && (
                  <div className="max-w-xs mx-auto pt-4">
                    <div className="flex justify-between items-end mb-2">
                      <div className="flex flex-col items-start">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Uso de Tokens</span>
                        <span className="text-[10px] font-medium text-slate-400">
                          ~{Math.max(0, Math.floor((TOKEN_LIMIT - usedTokens) / 1200))} análisis restantes
                        </span>
                      </div>
                      <span className="text-xs font-bold text-indigo-600">
                        {((usedTokens / TOKEN_LIMIT) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="usage-container">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${(usedTokens / TOKEN_LIMIT) * 100}%` }}
                        className="usage-bar" 
                      />
                    </div>
                    <p className="text-[10px] text-slate-400 mt-2 font-medium">
                      {usedTokens.toLocaleString()} / {TOKEN_LIMIT.toLocaleString()} tokens utilizados
                    </p>
                  </div>
                )}
              </header>

              <section className="grid grid-cols-1 gap-8">
                <div className="modern-card p-8">
                  <div className="flex flex-col md:flex-row gap-4">
                    <div className="flex-1 relative">
                      <input 
                        type="text" 
                        value={sentence}
                        onChange={(e) => setSentence(e.target.value)}
                        placeholder="Escribe una oración para analizar..."
                        className="modern-input pr-12"
                        onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
                      />
                      <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300">
                        <Search size={20} />
                      </div>
                    </div>
                    <button 
                      onClick={handleAnalyze}
                      disabled={loading || !sentence.trim()}
                      className="modern-button flex items-center justify-center gap-2 min-w-[160px]"
                    >
                      {loading ? <Loader2 className="animate-spin" size={20} /> : <Zap size={20} />}
                      {loading ? 'Analizando...' : 'Analizar'}
                    </button>
                  </div>
                  
                  <div className="flex flex-wrap gap-4 mt-6">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
                      <CheckCircle2 size={14} className="text-emerald-500" /> RAE Compliant
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
                      <CheckCircle2 size={14} className="text-emerald-500" /> IA Optimizada
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
                      <CheckCircle2 size={14} className="text-emerald-500" /> Historial Real
                    </div>
                  </div>
                </div>

                {loading && (
                  <div className="modern-card p-12 text-center space-y-6">
                    <div className="relative w-24 h-24 mx-auto">
                      <div className="absolute inset-0 border-4 border-indigo-100 rounded-full" />
                      <div className="absolute inset-0 border-4 border-indigo-600 rounded-full border-t-transparent animate-spin" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-sm font-bold text-indigo-600">{Math.round(progress)}%</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-xl font-bold text-slate-900">{loadingStage}</h3>
                      <p className="text-slate-400 text-sm font-medium">Estamos procesando tu oración según la NGLE</p>
                    </div>
                  </div>
                )}
                {/* Error Message */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="modern-card bg-red-50 border-red-100 flex items-center gap-4 text-red-700"
                    >
                      <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                        <AlertCircle size={20} />
                      </div>
                      <div className="flex-1">
                        <p className="text-xs font-bold uppercase tracking-wider mb-0.5">Error de Análisis</p>
                        <p className="text-sm font-medium">{error}</p>
                      </div>
                      <button 
                        onClick={() => setError(null)}
                        className="text-red-400 hover:text-red-600 transition-colors"
                      >
                        <X size={18} />
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Results Panel */}
                {result && !loading && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-8"
                  >
                    {/* Main Analysis Card */}
                    <div className="modern-card p-0 overflow-hidden">
                      <div className="bg-slate-900 text-white p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                        <div className="flex items-center gap-3">
                          <div className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
                          <h3 className="font-bold text-lg tracking-tight">Resultado del Análisis</h3>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="flex items-center gap-2 bg-white/10 px-3 py-1 rounded-lg border border-white/10">
                            <span className="text-[10px] font-bold uppercase text-slate-400">Confianza</span>
                            <span className="text-sm font-bold text-indigo-300">
                              {Math.round(result.confianza <= 1 ? result.confianza * 100 : result.confianza)}%
                            </span>
                          </div>
                          <div className="modern-badge bg-indigo-500/20 text-indigo-300 border-indigo-500/30">NGLE v2.5</div>
                        </div>
                      </div>
                      
                      <div className="p-8">
                        <div className="tree-container mb-8">
                          <div 
                            className="tree-grid" 
                            style={{ 
                              gridTemplateColumns: `repeat(${result.palabras.length}, minmax(120px, 1fr))` 
                            }}
                          >
                            {result.palabras.map((palabra, pIdx) => {
                              const isOmitted = palabra.texto.startsWith('(') && palabra.texto.endsWith(')');
                              return (
                                <div 
                                  key={`word-${pIdx}`} 
                                  className={`tree-word ${isOmitted ? 'tree-word-omitted' : ''}`}
                                  style={{ gridColumn: pIdx + 1, gridRow: 1 }}
                                >
                                  {palabra.texto}
                                </div>
                              );
                            })}

                            {(() => {
                              const wordRows = new Array(result.palabras.length).fill(2);
                              const levels: React.ReactNode[] = [];
                              const allLevels: any[] = [];
                              
                              result.palabras.forEach((palabra, pIdx) => {
                                palabra.niveles?.forEach((nivel, lIdx) => {
                                  allLevels.push({
                                    ...nivel,
                                    pIdx,
                                    span: nivel.ancho_grupo || 1,
                                    originalOrder: lIdx
                                  });
                                });
                              });

                              // Mejorar el ordenamiento: primero los más pequeños (hijos) y luego los más grandes (padres)
                              // También priorizamos etiquetas de núcleo para que estén pegadas a las palabras
                              const sortedLevels = allLevels.sort((a, b) => {
                                if (a.span !== b.span) return a.span - b.span;
                                
                                const isCoreA = /^(N|Det|E|P|Prep|D|Adj|V)$/i.test(a.etiqueta);
                                const isCoreB = /^(N|Det|E|P|Prep|D|Adj|V)$/i.test(b.etiqueta);
                                
                                if (isCoreA && !isCoreB) return -1;
                                if (!isCoreA && isCoreB) return 1;
                                
                                return a.pIdx - b.pIdx || a.originalOrder - b.originalOrder;
                              });

                              const gridOccupancy: { [row: number]: boolean[] } = {};

                              sortedLevels.forEach((nivel, idx) => {
                                const span = nivel.span;
                                const start = nivel.pIdx;
                                // Empezamos en la fila 2 (justo debajo de las palabras)
                                let targetRow = 2;
                                
                                while (true) {
                                  if (!gridOccupancy[targetRow]) {
                                    gridOccupancy[targetRow] = new Array(result.palabras.length).fill(false);
                                  }
                                  
                                  let collision = false;
                                  for (let i = start; i < start + span; i++) {
                                    if (gridOccupancy[targetRow][i]) {
                                      collision = true;
                                      break;
                                    }
                                  }
                                  
                                  if (!collision) {
                                    // Verificar que estamos por debajo de cualquier nivel que este nivel contenga
                                    let maxRowInSpan = 0;
                                    for (let i = start; i < start + span; i++) {
                                      maxRowInSpan = Math.max(maxRowInSpan, wordRows[i]);
                                    }
                                    if (targetRow >= maxRowInSpan) break;
                                  }
                                  targetRow++;
                                }

                                levels.push(
                                  <motion.div 
                                    key={`level-${idx}`} 
                                    initial={{ opacity: 0, scaleX: 0 }}
                                    animate={{ opacity: 1, scaleX: 1 }}
                                    transition={{ delay: 0.1 + idx * 0.02 }}
                                    className="tree-cell"
                                    style={{ 
                                      gridColumn: `${start + 1} / span ${span}`,
                                      gridRow: targetRow,
                                      transformOrigin: 'center'
                                    }}
                                  >
                                    <div className="tree-line" />
                                    <span className="tree-label">{nivel.etiqueta}</span>
                                  </motion.div>
                                );

                                // Marcar ocupación y actualizar altura para futuros niveles superiores
                                for (let i = start; i < start + span; i++) {
                                  gridOccupancy[targetRow][i] = true;
                                  wordRows[i] = targetRow + 1;
                                }
                              });

                              return levels;
                            })()}
                          </div>
                        </div>

                        <div className="text-center py-8 border-t border-slate-100">
                          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Clasificación Global</h4>
                          <p className="text-2xl md:text-3xl font-bold text-slate-900 tracking-tight">
                            {result.tipo_global}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                      {/* Stats Card */}
                      <div className="modern-card space-y-6">
                        <div className="flex items-center gap-2 text-slate-900">
                          <Info size={18} className="text-indigo-600" />
                          <h3 className="font-bold tracking-tight">Detalles Técnicos</h3>
                        </div>
                        <div className="space-y-4">
                          <div className="flex justify-between items-center py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-500 font-medium">Palabras</span>
                            <span className="text-sm font-bold text-slate-900">{result.palabras.length}</span>
                          </div>
                          <div className="flex justify-between items-center py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-500 font-medium">Profundidad</span>
                            <span className="text-sm font-bold text-slate-900">
                              {Math.max(...result.palabras.map(p => p.niveles?.length || 0))} niveles
                            </span>
                          </div>
                          {result.usage && (
                            <div className="flex justify-between items-center py-2 border-b border-slate-50">
                              <span className="text-sm text-slate-500 font-medium">Costo de Análisis</span>
                              <span className="text-sm font-bold text-indigo-600">{result.usage.totalTokenCount} tokens</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Notes Card */}
                      <div className="md:col-span-2 modern-card bg-slate-50 border-none">
                        <div className="flex items-center gap-2 text-slate-900 mb-4">
                          <BookOpen size={18} className="text-indigo-600" />
                          <h3 className="font-bold tracking-tight">Notas Lingüísticas (NGLE)</h3>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {result.notas_ngle.map((nota, idx) => (
                            <div key={idx} className="flex gap-3 text-sm text-slate-600 leading-relaxed">
                              <div className="mt-1.5 w-1.5 h-1.5 bg-indigo-400 rounded-full shrink-0" />
                              {nota}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Feedback Section */}
                    <div className="modern-card bg-indigo-600 text-white border-none">
                      <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                        <div className="text-center md:text-left">
                          <h3 className="text-xl font-bold tracking-tight mb-1">¿Es correcto el análisis?</h3>
                          <p className="text-indigo-100 text-sm">Tu feedback ayuda a mejorar la precisión del motor.</p>
                        </div>
                        
                        <div className="flex flex-wrap justify-center gap-3">
                          {!feedbackSent ? (
                            <>
                              <button 
                                onClick={() => sendFeedback(true)}
                                className="bg-white text-indigo-600 px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-indigo-50 transition-colors"
                              >
                                <ThumbsUp size={16} /> Sí, es correcto
                              </button>
                              <button 
                                onClick={() => setShowCorrectionInput(true)}
                                className="bg-indigo-500 text-white px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-indigo-400 transition-colors"
                              >
                                <ThumbsDown size={16} /> Hay errores
                              </button>
                            </>
                          ) : (
                            <motion.div 
                              initial={{ scale: 0.9, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              className="bg-indigo-500/30 text-white px-8 py-3 rounded-xl font-bold text-sm border border-indigo-400/30"
                            >
                              ¡Gracias por tu feedback!
                            </motion.div>
                          )}
                        </div>
                      </div>

                      <AnimatePresence>
                        {showCorrectionInput && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="mt-8 pt-8 border-t border-indigo-500 overflow-hidden"
                          >
                            <label className="block text-xs font-bold uppercase tracking-wider text-indigo-200 mb-3">Propón una corrección o explica el error:</label>
                            <div className="flex flex-col md:flex-row gap-3">
                              <input 
                                type="text"
                                value={correction}
                                onChange={(e) => setCorrection(e.target.value)}
                                placeholder="Ej: 'coche' debería ser el núcleo del CD..."
                                className="flex-1 bg-indigo-700 border-none rounded-xl px-4 py-3 text-white placeholder:text-indigo-300 focus:ring-2 focus:ring-white/20 outline-none"
                              />
                              <button 
                                onClick={() => sendFeedback(false, correction)}
                                className="bg-white text-indigo-600 px-8 py-3 rounded-xl font-bold text-sm hover:bg-indigo-50 transition-colors"
                              >
                                Enviar Corrección
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </section>

              {/* Examples Section */}
              {!result && !loading && (
                <motion.section 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 }}
                  className="mt-20"
                >
                  <div className="flex items-center gap-4 mb-8">
                    <div className="h-px flex-1 bg-slate-200" />
                    <h2 className="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Ejemplos de Análisis</h2>
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[
                      "El perro de San Roque no tiene rabo.",
                      "Me gusta mucho el chocolate belga.",
                      "Díselo a tu hermano mañana."
                    ].map((ex, i) => (
                      <button 
                        key={i}
                        onClick={() => setSentence(ex)}
                        className="modern-card text-left p-6 group hover:border-indigo-200 transition-all"
                      >
                        <div className="w-8 h-8 bg-slate-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-indigo-50 transition-colors">
                          <span className="text-xs font-bold text-slate-400 group-hover:text-indigo-600">{i + 1}</span>
                        </div>
                        <p className="text-sm font-bold text-slate-900 leading-relaxed group-hover:text-indigo-600 transition-colors">
                          "{ex}"
                        </p>
                      </button>
                    ))}
                  </div>
                </motion.section>
              )}
            </motion.div>
          )}

          {currentPage === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                <div>
                  <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Tu Historial</h2>
                  <p className="text-slate-500 mt-1">Repasa tus análisis lingüísticos anteriores.</p>
                </div>
                {!user ? (
                  <div className="modern-badge bg-amber-50 text-amber-700 border-amber-200">
                    Inicia sesión para guardar tu historial
                  </div>
                ) : (
                  <div className="modern-badge bg-slate-100 text-slate-600 border-slate-200">
                    {history.length} análisis guardados
                  </div>
                )}
              </div>
              
              {loadingHistory ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                  <Loader2 className="animate-spin text-indigo-600" size={48} />
                  <p className="text-sm font-bold text-slate-500 uppercase tracking-widest">Cargando historial...</p>
                </div>
              ) : history.length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                  {history.map((item, idx) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      whileHover={{ y: -2 }}
                      className="modern-card p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 hover:border-indigo-200 transition-all cursor-pointer group"
                      onClick={() => {
                        setSentence(item.sentence);
                        setResult(item.result);
                        setCurrentPage('home');
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            {item.timestamp?.toDate().toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                          <div className="w-1 h-1 bg-slate-300 rounded-full" />
                          <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">
                            {item.result.tipo_global.split('/')[0]}
                          </span>
                        </div>
                        <h3 className="text-lg font-bold text-slate-900 truncate group-hover:text-indigo-600 transition-colors">
                          "{item.sentence}"
                        </h3>
                      </div>
                      
                      <div className="flex items-center gap-6 shrink-0">
                        <div className="text-right hidden sm:block">
                          <p className="text-[10px] font-bold uppercase text-slate-400 mb-1">Confianza</p>
                          <p className="text-lg font-bold text-slate-900">
                            {Math.round(item.result.confianza <= 1 ? item.result.confianza * 100 : item.result.confianza)}%
                          </p>
                        </div>
                        <div className="w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-all">
                          <ChevronRight size={20} />
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="modern-card py-20 text-center border-dashed border-2 border-slate-200 bg-transparent">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <History size={32} className="text-slate-300" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mb-2">No hay historial todavía</h3>
                  <p className="text-slate-500 max-w-xs mx-auto">Tus análisis aparecerán aquí automáticamente cuando empieces a usar la herramienta.</p>
                  <button 
                    onClick={() => setCurrentPage('home')}
                    className="mt-6 text-indigo-600 font-bold text-sm hover:underline"
                  >
                    Comenzar ahora →
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {currentPage === 'about' && (
            <motion.div
              key="about"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-16"
            >
              <div className="flex flex-col md:flex-row items-center gap-12">
                <div className="flex-1 space-y-6">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 text-indigo-600 text-xs font-bold uppercase tracking-wider">
                    <BookOpen size={14} />
                    Nuestra Misión
                  </div>
                  <h2 className="text-4xl md:text-5xl font-bold text-slate-900 tracking-tight leading-tight">
                    Democratizando el análisis <span className="text-indigo-600">sintáctico</span> profesional.
                  </h2>
                  <p className="text-lg text-slate-600 leading-relaxed">
                    Sintaxis AI nace de la necesidad de herramientas educativas que no solo den respuestas, 
                    sino que sigan los estándares académicos más rigurosos de la RAE y la ASALE.
                  </p>
                  <div className="flex flex-wrap gap-4 pt-4">
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                      <div className="w-5 h-5 rounded-full bg-green-100 text-green-600 flex items-center justify-center">
                        <Check size={12} />
                      </div>
                      Basado en NGLE 2024
                    </div>
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                      <div className="w-5 h-5 rounded-full bg-green-100 text-green-600 flex items-center justify-center">
                        <Check size={12} />
                      </div>
                      Precisión del 98%
                    </div>
                  </div>
                </div>
                <div className="flex-1 relative">
                  <div className="absolute -inset-4 bg-indigo-100 rounded-3xl -rotate-3" />
                  <div className="relative modern-card p-8 bg-white shadow-2xl">
                    <pre className="text-xs font-mono text-slate-400 overflow-hidden">
                      {`{
  "oracion": "El niño lee un libro",
  "analisis": {
    "sujeto": "El niño",
    "predicado": "lee un libro",
    "nucleo": "lee",
    "complementos": [
      { "tipo": "CD", "texto": "un libro" }
    ]
  }
}`}
                    </pre>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="modern-card p-8 space-y-4">
                  <div className="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600">
                    <Zap size={24} />
                  </div>
                  <h3 className="text-xl font-bold text-slate-900">Velocidad Instantánea</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Análisis complejos en menos de 2 segundos gracias a nuestro motor optimizado con IA de última generación.
                  </p>
                </div>
                <div className="modern-card p-8 space-y-4">
                  <div className="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600">
                    <BookOpen size={24} />
                  </div>
                  <h3 className="text-xl font-bold text-slate-900">Rigor Académico</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Cada resultado es validado contra las normas de la Nueva Gramática de la Lengua Española.
                  </p>
                </div>
                <div className="modern-card p-8 space-y-4">
                  <div className="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600">
                    <History size={24} />
                  </div>
                  <h3 className="text-xl font-bold text-slate-900">Historial Inteligente</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Guarda y repasa tus análisis anteriores para estudiar patrones lingüísticos y mejorar tu aprendizaje.
                  </p>
                </div>
              </div>

              <div className="modern-card bg-slate-900 text-white p-12 text-center border-none">
                <h3 className="text-3xl font-bold mb-4">¿Listo para empezar?</h3>
                <p className="text-slate-400 mb-8 max-w-lg mx-auto">
                  Únete a miles de estudiantes y profesores que ya utilizan Sintaxis AI para sus estudios lingüísticos.
                </p>
                <button 
                  onClick={() => setCurrentPage('home')}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white px-10 py-4 rounded-2xl font-bold transition-all shadow-lg shadow-indigo-500/20"
                >
                  Analizar mi primera oración
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="mt-20 border-t border-slate-100 bg-white py-12">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex flex-col md:flex-row justify-between items-center gap-8 mb-8">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold text-xs">S</div>
              <span className="font-bold text-slate-900 tracking-tight">Sintaxis AI</span>
            </div>
            <div className="flex gap-8">
              <a href="#" className="text-sm font-bold text-slate-400 hover:text-indigo-600 transition-colors">Privacidad</a>
              <a href="#" className="text-sm font-bold text-slate-400 hover:text-indigo-600 transition-colors">Términos</a>
              <a href="#" className="text-sm font-bold text-slate-400 hover:text-indigo-600 transition-colors">Contacto</a>
            </div>
          </div>
          <div className="pt-8 border-t border-slate-50 flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">© 2026 Sintaxis AI. Todos los derechos reservados.</p>
            <p className="text-xs text-slate-400">Hecho con ❤️ para la comunidad lingüística.</p>
          </div>
        </div>
      </footer>
    </div>
    </ErrorBoundary>
  );
}
