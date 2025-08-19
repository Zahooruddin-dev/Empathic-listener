import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import {
	FaMicrophone,
	FaPaperPlane,
	FaStop,
	FaVolumeUp,
	FaRegCopy,
	FaCheck,
	FaCog,
	FaDownload,
	FaUpload,
	FaTrash,
	FaHeart,
	FaRobot,
	FaUser,
} from 'react-icons/fa';

/**
 * ALL-IN-ONE APP.JSX — Empathic Listener
 * - Single-file implementation as requested (no external components)
 * - Voice input + TTS, copy, share/export, import, local cache, localStorage persistence
 * - Prompt enhancer + slash commands + presets
 * - Lightweight sentiment analysis to shape responses and follow-ups
 * - Retry with backoff, basic rate-limit handling, and client-side debounced autosave
 * - Clean Tailwind-first UI (no external CSS required)
 */

const GEMINI_ENDPOINT = (key) =>
	`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
const LOCAL_KEY = 'empathic_listener_state_v2';

// ---------- Small Utilities ----------
const nowISO = () => new Date().toISOString();
const clamp = (v, a, b) => Math.max(a, Math.min(v, b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function useLocalStorageState(key, initial) {
	const [state, setState] = useState(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw ? JSON.parse(raw) : initial;
		} catch {
			return initial;
		}
	});
	useEffect(() => {
		const id = setTimeout(() => {
			try {
				localStorage.setItem(key, JSON.stringify(state));
			} catch {}
		}, 250);
		return () => clearTimeout(id);
	}, [key, state]);
	return [state, setState];
}

// Naive keyword sentiment (client-side hinting only)
function sentimentScore(text) {
	if (!text) return 0;
	const NEG = [
		'sad',
		'depressed',
		'anxious',
		'anxiety',
		'stressed',
		'alone',
		'lonely',
		'angry',
		'upset',
		'hurt',
		'ashamed',
		'guilty',
		'tired',
		'overwhelmed',
		'panic',
		'cry',
		'hate',
		'worthless',
		'failure',
		'lost',
		'hopeless',
		'suicidal',
	]; // not a diagnostic
	const POS = [
		'grateful',
		'happy',
		'hopeful',
		'excited',
		'proud',
		'calm',
		'relieved',
		'love',
		'optimistic',
		'progress',
		'peace',
	];
	const t = text.toLowerCase();
	let s = 0;
	NEG.forEach((w) => {
		if (t.includes(w)) s -= 1;
	});
	POS.forEach((w) => {
		if (t.includes(w)) s += 1;
	});
	return s;
}

function formatTime(ts) {
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return ts;
	}
}

function classNames(...xs) {
	return xs.filter(Boolean).join(' ');
}

// ---------- Inline UI helpers ----------
function Pill({ children, active = false, onClick }) {
	return (
		<button
			onClick={onClick}
			className={classNames(
				'px-3 py-1 rounded-full text-xs border transition',
				active
					? 'bg-blue-600 border-blue-600 text-white'
					: 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
			)}
		>
			{children}
		</button>
	);
}

function LoadingDots() {
	return (
		<span className='inline-flex gap-1 ml-2 align-middle'>
			<span className='w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce' />
			<span className='w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:120ms]' />
			<span className='w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:240ms]' />
		</span>
	);
}

function CopyButton({ text }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				} catch {}
			}}
			className='p-1.5 rounded hover:bg-gray-700 text-gray-300'
			title='Copy'
		>
			{copied ? <FaCheck /> : <FaRegCopy />}
		</button>
	);
}

function SpeakButton({ text }) {
	const [isSpeaking, setIsSpeaking] = useState(false);
	const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
	return (
		<button
			disabled={!canSpeak}
			onClick={() => {
				if (!canSpeak) return;
				if (isSpeaking) {
					window.speechSynthesis.cancel();
					setIsSpeaking(false);
				} else {
					const u = new SpeechSynthesisUtterance(text);
					u.lang = 'en-US';
					u.onend = () => setIsSpeaking(false);
					setIsSpeaking(true);
					window.speechSynthesis.speak(u);
				}
			}}
			className={classNames(
				'p-1.5 rounded text-gray-300',
				canSpeak ? 'hover:bg-gray-700' : 'opacity-50 cursor-not-allowed'
			)}
			title={isSpeaking ? 'Stop' : 'Speak'}
		>
			{isSpeaking ? <FaStop /> : <FaVolumeUp />}
		</button>
	);
}

// ---------- Main App ----------
export default function App() {
	const [ready, setReady] = useState(false);
	const [isListening, setIsListening] = useState(false);
	const [recognition, setRecognition] = useState(null);

	const [state, setState] = useLocalStorageState(LOCAL_KEY, {
		apiKey: '', // supply at runtime
		temperature: 0.7,
		topP: 0.95,
		topK: 40,
		quickReplies: true,
		empathicMode: true,
		model: 'gemini-2.0-flash',
		chat: [], // {role: 'user'|'assistant', text, ts}
		input: '',
		presets: [
			{
				label: 'Empathic',
				prompt:
					'Please listen with empathy and reflect feelings, needs, and offer gentle next steps.',
			},
			{
				label: 'Coach',
				prompt:
					'Act as a supportive life coach. Ask one clarifying question, then suggest a next action.',
			},
			{
				label: 'Solution',
				prompt:
					'Be concise and solution-focused: summarize problem in one line; list 3 options; ask for preference.',
			},
			{
				label: 'Journal',
				prompt:
					'You are a reflective journaling companion. Reframe my thoughts without judgment and suggest a 2-minute exercise.',
			},
		],
	});

	const cacheRef = useRef(new Map());
	const listRef = useRef(null);

	// Auto-scroll to bottom on new messages
	useEffect(() => {
		listRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
	}, [state.chat]);

	// Initialize speech recognition (webkitSpeechRecognition only)
	useEffect(() => {
		setReady(true);
		if ('webkitSpeechRecognition' in window) {
			const r = new window.webkitSpeechRecognition();
			r.continuous = false;
			r.interimResults = false;
			r.lang = 'en-US';
			r.onresult = (e) => {
				const transcript = e.results[0][0].transcript;
				setState((s) => ({ ...s, input: transcript }));
				setIsListening(false);
			};
			r.onerror = () => setIsListening(false);
			r.onend = () => setIsListening(false);
			setRecognition(r);
		}
	}, []); // eslint-disable-line

	const startStopListening = () => {
		if (!recognition) return;
		if (isListening) {
			recognition.stop();
			setIsListening(false);
		} else {
			recognition.start();
			setIsListening(true);
		}
	};

	// ------- Prompt enhancement & command routing -------
	const enhancePrompt = (raw) => {
		const sScore = sentimentScore(raw);
		const toneHint =
			sScore < 0
				? 'gentle, validating, non-judgmental'
				: sScore > 0
				? 'encouraging, balanced'
				: 'neutral, respectful';
		const empathicScaffold = state.empathicMode
			? `\n\nFollow this structure briefly: 1) Reflect what you heard, 2) Name underlying needs/values, 3) Offer 2 options (self-care + practical), 4) Ask a small open question.`
			: '';

		return `You are an empathic, trauma-informed AI listener. Avoid medical/clinical claims. Be kind, concise and specific. Use plain language.\nTone: ${toneHint}.${empathicScaffold}\n\nUser message: ${raw}`;
	};

	const routeSlashCommand = (text) => {
		const t = text.trim();
		if (t.startsWith('/')) {
			const [cmd, ...rest] = t.slice(1).split(' ');
			const body = rest.join(' ');
			switch (cmd.toLowerCase()) {
				case 'summarize':
					return `Summarize this in 3 bullets and 1 next step.\n\n${body}`;
				case 'reframe':
					return `Reframe this thought compassionately and propose one experiment.\n\n${body}`;
				case 'coach':
					return `Act as a supportive coach: ask one clarifying question, then suggest a next action.\n\n${body}`;
				case 'journal':
					return `Help me journal: give a 4-line guided prompt, then hold space for 60 seconds (describe a quick breathing anchor).\n\n${body}`;
				default:
					return text; // unknown
			}
		}
		return text;
	};

	// Generate quick replies from last assistant message
	const quickReplies = useMemo(() => {
		if (!state.quickReplies) return [];
		const last = [...state.chat].reverse().find((m) => m.role === 'assistant');
		if (!last) return [];
		const base = [
			'Tell me more',
			'That resonates',
			'Can you give examples?',
			"What's one next step?",
			'Reframe this kindly',
		];
		const s = sentimentScore(last.text);
		if (s < 0) base.unshift('I feel overwhelmed', 'I need reassurance');
		else base.unshift('Sounds good', "Let's plan a step");
		return base.slice(0, 5);
	}, [state.chat, state.quickReplies]);

	const [busy, setBusy] = useState(false);

	// ------- Core send -------
	const send = async () => {
		const question = state.input.trim();
		if (!question || busy) return;

		const apiKey =
			state.apiKey ||
			import.meta?.env?.VITE_API_GENERATIVE_LANGUAGE_CLIENT ||
			'';
		if (!apiKey) {
			alert(
				'Missing API key. Paste your Google Generative Language API key in Settings (gear icon).'
			);
			return;
		}

		const outgoing = { role: 'user', text: question, ts: nowISO() };
		setState((s) => ({ ...s, chat: [...s.chat, outgoing], input: '' }));

		// Cache hit
		if (cacheRef.current.has(question)) {
			const cached = cacheRef.current.get(question);
			setState((s) => ({
				...s,
				chat: [
					...s.chat,
					{ role: 'assistant', text: cached, ts: nowISO(), cached: true },
				],
			}));
			return;
		}

		const MAX_ATTEMPTS = 3;
		let attempt = 0;
		let delay = 1200;
		setBusy(true);

		const enhanced = enhancePrompt(routeSlashCommand(question));

		while (attempt < MAX_ATTEMPTS) {
			try {
				const payload = {
					contents: [{ role: 'user', parts: [{ text: enhanced }] }],
					generationConfig: {
						temperature: clamp(Number(state.temperature) || 0.7, 0, 2),
						topP: clamp(Number(state.topP) || 0.95, 0, 1),
						topK: clamp(Number(state.topK) || 40, 1, 200),
						candidateCount: 1,
					},
				};

				const res = await axios.post(GEMINI_ENDPOINT(apiKey), payload, {
					headers: { 'Content-Type': 'application/json' },
				});
				const text = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
				if (!text) throw new Error('Empty model response');

				// Optionally wrap with a tiny empathetic header on negative user sentiment
				const sUser = sentimentScore(question);
				const wrap =
					sUser < 0 && state.empathicMode
						? `🫶 \n\n${text}`
						: text;
//You’re not alone. Here’s a gentle take:
				cacheRef.current.set(question, wrap);
				setState((s) => ({
					...s,
					chat: [...s.chat, { role: 'assistant', text: wrap, ts: nowISO() }],
				}));
				break;
			} catch (err) {
				console.error(err);
				attempt++;
				if (
					axios.isAxiosError(err) &&
					err.response?.status === 429 &&
					attempt < MAX_ATTEMPTS
				) {
					await sleep(delay);
					delay *= 2;
					continue;
				}
				const msg =
					axios.isAxiosError(err) && err.response?.data?.error?.message
						? err.response.data.error.message
						: 'Sorry, something went wrong. Please try again.';
				setState((s) => ({
					...s,
					chat: [
						...s.chat,
						{ role: 'assistant', text: msg, ts: nowISO(), error: true },
					],
				}));
				break;
			} finally {
				setBusy(false);
			}
		}
	};

	// ------- Keyboard -------
	const onKeyDown = (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	// ------- Export / Import / Clear -------
	const exportChat = () => {
		const blob = new Blob([JSON.stringify(state, null, 2)], {
			type: 'application/json',
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `empathic-listener-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const importChat = async (file) => {
		const text = await file.text();
		try {
			const data = JSON.parse(text);
			if (!data || typeof data !== 'object') throw new Error('Invalid file');
			setState(data);
		} catch (e) {
			alert('Import failed: ' + e.message);
		}
	};

	const clearChat = () => {
		if (confirm('Clear all messages?')) setState((s) => ({ ...s, chat: [] }));
	};

	// ------- UI -------
	return (
		<div className='min-h-screen w-full bg-black text-gray-100 flex flex-col'>
			{/* Header */}
			<header className='sticky top-0 z-10 bg-[#040E23] border-b border-gray-800'>
				<div className='max-w-5xl mx-auto px-4 py-3 flex items-center justify-between'>
					<div className='flex items-center gap-2'>
						<FaHeart className='text-pink-500' />
						<h1 className='text-lg sm:text-2xl font-bold'>Empathic Listener</h1>
					</div>
					<div className='flex items-center gap-2'>
						<button
							onClick={exportChat}
							className='px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-2 text-sm'
						>
							<FaDownload />
							Export
						</button>
						<label className='px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-2 text-sm cursor-pointer'>
							<FaUpload />
							<input
								type='file'
								accept='application/json'
								className='hidden'
								onChange={(e) => {
									const f = e.target.files?.[0];
									if (f) importChat(f);
									e.currentTarget.value = '';
								}}
							/>
							Import
						</label>
						<button
							onClick={clearChat}
							className='px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-2 text-sm'
						>
							<FaTrash />
							Clear
						</button>
						<Settings state={state} setState={setState} />
					</div>
				</div>
				{/* Presets */}
				<div className='max-w-5xl mx-auto px-4 pb-3 flex flex-wrap gap-2'>
					{state.presets.map((p, i) => (
						<Pill
							key={i}
							onClick={() => setState((s) => ({ ...s, input: p.prompt }))}
						>
							{p.label}
						</Pill>
					))}
				</div>
			</header>

			{/* Chat list */}
			<main className='flex-1 overflow-y-auto'>
				<div ref={listRef} className='max-w-5xl mx-auto px-4 py-4 space-y-3'>
					{state.chat.length === 0 && (
						<div className='bg-gray-900/40 border border-gray-800 rounded-2xl p-6 text-gray-300'>
							<p className='text-sm mb-2'>
								Welcome 👋 I’m here to listen. Try one of these:
							</p>
							<ul className='list-disc pl-5 space-y-1 text-sm'>
								<li>“I feel anxious about my future.”</li>
								<li>“/summarize This is everything on my mind…”</li>
								<li>“/journal Help me process today.”</li>
								<li>“/coach I keep procrastinating.”</li>
							</ul>
						</div>
					)}

					{state.chat.map((m, idx) => (
						<MessageBubble key={idx} m={m} />
					))}

					{busy && (
						<div className='flex items-start gap-3 bg-gray-900 border border-gray-800 rounded-2xl p-3'>
							<div className='mt-1'>
								<FaRobot className='text-blue-400' />
							</div>
							<div className='text-sm text-gray-300'>
								Thinking
								<LoadingDots />
							</div>
						</div>
					)}
				</div>
			</main>

			{/* Composer */}
			<footer className='sticky bottom-0 bg-black border-t border-gray-800'>
				<div className='max-w-5xl mx-auto px-4 py-3'>
					<div className='flex items-end gap-2'>
						<div className='flex-1'>
							<textarea
								value={state.input}
								onChange={(e) =>
									setState((s) => ({ ...s, input: e.target.value }))
								}
								onKeyDown={onKeyDown}
								placeholder='Your AI mate is here to help… (Shift+Enter for newline, /summarize, /reframe, /coach, /journal)'
								rows={1}
								className='w-full resize-none bg-gray-900 border border-gray-800 rounded-2xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600'
							/>
							{state.quickReplies && quickReplies.length > 0 && (
								<div className='mt-2 flex flex-wrap gap-2'>
									{quickReplies.map((q, i) => (
										<Pill
											key={i}
											onClick={() =>
												setState((s) => ({
													...s,
													input: (s.input ? s.input + ' ' : '') + q,
												}))
											}
										>
											{q}
										</Pill>
									))}
								</div>
							)}
						</div>

						<div className='flex items-center gap-2'>
							{recognition && (
								<button
									onClick={startStopListening}
									className={classNames(
										'p-3 rounded-full transition',
										isListening ? 'bg-red-600' : 'bg-blue-600 hover:bg-blue-700'
									)}
									title={isListening ? 'Stop listening' : 'Voice input'}
								>
									<FaMicrophone />
								</button>
							)}
							<button
								disabled={busy}
								onClick={send}
								className='p-3 rounded-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50'
								title='Send'
							>
								<FaPaperPlane />
							</button>
						</div>
					</div>
					<div className='mt-2 text-[11px] text-gray-500'>
						Tip: Empathic mode shapes tone; adjust in Settings. This is not a
						substitute for professional help.
					</div>
				</div>
			</footer>
		</div>
	);
}

function MessageBubble({ m }) {
	const mine = m.role === 'user';
	return (
		<div
			className={classNames(
				'flex gap-3',
				mine ? 'justify-end' : 'justify-start'
			)}
		>
			{!mine && (
				<div className='mt-1 shrink-0 w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center'>
					<FaRobot className='text-black' />
				</div>
			)}
			<div
				className={classNames(
					'max-w-[90%] sm:max-w-[75%] rounded-2xl border px-3 py-2',
					mine
						? 'bg-blue-600 border-blue-500 text-white'
						: 'bg-gray-900 border-gray-800 text-gray-100'
				)}
			>
				<div className='prose prose-invert prose-p:my-2 prose-pre:my-2 prose-ul:my-2 text-sm'>
					<ReactMarkdown>{m.text}</ReactMarkdown>
				</div>
				<div className='mt-2 flex items-center justify-between text-[11px] text-gray-400'>
					<div>
						{formatTime(m.ts)}{' '}
						{m.cached && <span className='ml-1'>· cached</span>}{' '}
						{m.error && <span className='ml-1 text-red-400'>· error</span>}
					</div>
					{!mine && (
						<div className='flex items-center gap-1'>
							<SpeakButton text={m.text} />
							<CopyButton text={m.text} />
						</div>
					)}
				</div>
			</div>
			{mine && (
				<div className='mt-1 shrink-0 w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center'>
					<FaUser />
				</div>
			)}
		</div>
	);
}

function Settings({ state, setState }) {
	const [open, setOpen] = useState(false);
	return (
		<div className='relative'>
			<button
				onClick={() => setOpen((o) => !o)}
				className='px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 flex items-center gap-2 text-sm'
			>
				<FaCog />
				Settings
			</button>
			{open && (
				<div className='absolute right-0 mt-2 w-80 bg-gray-950 border border-gray-800 rounded-xl p-3 z-20 shadow-xl'>
					<div className='space-y-3 text-sm'>
						<div>
							<label className='block text-gray-400 mb-1'>
								Google Generative Language API Key
							</label>
							<input
								type='password'
								value={state.apiKey}
								onChange={(e) =>
									setState((s) => ({ ...s, apiKey: e.target.value }))
								}
								placeholder='Paste your key here'
								className='w-full bg-gray-900 border border-gray-800 rounded px-2 py-1'
							/>
						</div>
						<div className='grid grid-cols-3 gap-2'>
							<div>
								<label className='block text-gray-400 mb-1'>Temp</label>
								<input
									type='number'
									step='0.1'
									min='0'
									max='2'
									value={state.temperature}
									onChange={(e) =>
										setState((s) => ({ ...s, temperature: e.target.value }))
									}
									className='w-full bg-gray-900 border border-gray-800 rounded px-2 py-1'
								/>
							</div>
							<div>
								<label className='block text-gray-400 mb-1'>topP</label>
								<input
									type='number'
									step='0.01'
									min='0'
									max='1'
									value={state.topP}
									onChange={(e) =>
										setState((s) => ({ ...s, topP: e.target.value }))
									}
									className='w-full bg-gray-900 border border-gray-800 rounded px-2 py-1'
								/>
							</div>
							<div>
								<label className='block text-gray-400 mb-1'>topK</label>
								<input
									type='number'
									step='1'
									min='1'
									max='200'
									value={state.topK}
									onChange={(e) =>
										setState((s) => ({ ...s, topK: e.target.value }))
									}
									className='w-full bg-gray-900 border border-gray-800 rounded px-2 py-1'
								/>
							</div>
						</div>
						<div className='flex items-center justify-between'>
							<label className='flex items-center gap-2 text-gray-200'>
								<input
									type='checkbox'
									checked={state.empathicMode}
									onChange={(e) =>
										setState((s) => ({ ...s, empathicMode: e.target.checked }))
									}
								/>
								Empathic mode
							</label>
							<label className='flex items-center gap-2 text-gray-200'>
								<input
									type='checkbox'
									checked={state.quickReplies}
									onChange={(e) =>
										setState((s) => ({ ...s, quickReplies: e.target.checked }))
									}
								/>
								Quick replies
							</label>
						</div>
						<div>
							<label className='block text-gray-400 mb-1'>
								Add / edit presets
							</label>
							<PresetEditor
								presets={state.presets}
								onChange={(presets) => setState((s) => ({ ...s, presets }))}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function PresetEditor({ presets, onChange }) {
	const [local, setLocal] = useState(presets);
	useEffect(() => setLocal(presets), [presets]);
	const update = (i, field, val) =>
		setLocal((p) =>
			p.map((x, idx) => (idx === i ? { ...x, [field]: val } : x))
		);
	const add = () =>
		setLocal((p) => [
			...p,
			{ label: 'New', prompt: 'Describe how I should respond' },
		]);
	const remove = (i) => setLocal((p) => p.filter((_, idx) => idx !== i));
	return (
		<div className='space-y-2'>
			{local.map((p, i) => (
				<div key={i} className='grid grid-cols-5 gap-2'>
					<input
						value={p.label}
						onChange={(e) => update(i, 'label', e.target.value)}
						className='col-span-1 bg-gray-900 border border-gray-800 rounded px-2 py-1'
					/>
					<input
						value={p.prompt}
						onChange={(e) => update(i, 'prompt', e.target.value)}
						className='col-span-4 bg-gray-900 border border-gray-800 rounded px-2 py-1'
					/>
					<div className='col-span-5 flex justify-end'>
						<button
							onClick={() => remove(i)}
							className='text-xs text-red-400 hover:underline'
						>
							Remove
						</button>
					</div>
				</div>
			))}
			<div className='flex justify-between'>
				<button onClick={add} className='text-xs text-blue-400 hover:underline'>
					Add preset
				</button>
				<button
					onClick={() => onChange(local)}
					className='text-xs text-green-400 hover:underline'
				>
					Save presets
				</button>
			</div>
		</div>
	);
}
