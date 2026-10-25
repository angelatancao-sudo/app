import { useEffect, useRef, useState } from "react";
import "./Phonema.css";

const DEMO_MODE = true;
const API = "/api";

const trainingPhrases = [
  { id: "p1", text: "I would like some water." },
  { id: "p2", text: "Please help me." },
  { id: "p3", text: "I am ready to go." },
  { id: "p4", text: "I am hungry." },
  { id: "p5", text: "Thank you." },
  { id: "p6", text: "I need to use the bathroom." },
];

class OfflineError extends Error {}

async function request(path, options = {}) {
  let response;

  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        // Skips ngrok's free-tier HTML warning page, which otherwise
        // breaks JSON parsing. Don't set Content-Type yourself with FormData.
        "ngrok-skip-browser-warning": "true",
        ...options.headers,
      },
    });
  } catch {
    // Network failure or CORS block
    throw new OfflineError("Could not reach the backend.");
  }

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(
          `Server error ${response.status}: ${text.slice(0, 300)}`
        );
      }
      throw new OfflineError(
        `Non-JSON reply (status ${response.status}): ${text.slice(0, 200)}`
      );
    }
  }

  if (!response.ok) {
    const detail = data?.detail;
    throw new Error(
      data?.message ||
        (typeof detail === "string"
          ? detail
          : detail
            ? JSON.stringify(detail)
            : `Request failed (${response.status}).`)
    );
  }

  return data;
}

async function toWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();

  const rate = 16000;
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * rate),
    rate
  );
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const audio = await offline.startRendering();
  const samples = audio.getChannelData(0);

  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, s) =>
    [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));

  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);

  samples.forEach((v, i) => {
    const s = Math.max(-1, Math.min(1, v));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  });

  return new Blob([view], { type: "audio/wav" });
}

function MicrophoneIcon() {
  return (
    <svg
      className="microphone"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
    </svg>
  );
}

function Popup({
  title,
  children,
  onClose,
  onEnd,
  label = "Got it",
}) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;

    if (!dialog.open) dialog.showModal();

    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby="popup-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="popup-title">{title}</h2>
      <div className="popup-text">{children}</div>

      <button autoFocus onClick={onClose}>
        {label}
      </button>

      {onEnd && (
        <button className="secondary" onClick={onEnd}>
          End instructions
        </button>
      )}
    </dialog>
  );
}

function Recorder({
  onRecorded,
  onPhase,
  disabled = false,
}) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");

  const recorder = useRef(null);
  const stream = useRef(null);
  const mounted = useRef(false);
  const callbacks = useRef({ onRecorded, onPhase });

  callbacks.current = { onRecorded, onPhase };

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;

      if (recorder.current?.state === "recording") {
        recorder.current.stop();
      }

      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  function changePhase(value) {
    setStatus(value);
    callbacks.current.onPhase(value);
  }

  async function start() {
    setError("");
    window.speechSynthesis?.cancel();
    changePhase("permission");

    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        !window.MediaRecorder
      ) {
        throw new Error(
          "Recording is unavailable. Use a supported browser on localhost or HTTPS."
        );
      }

      const input = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      if (!mounted.current) {
        input.getTracks().forEach((track) => track.stop());
        return;
      }

      stream.current = input;

      const media = new MediaRecorder(input);
      const chunks = [];
      let failed = false;

      recorder.current = media;

      media.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };

      media.onerror = () => {
        failed = true;
        input.getTracks().forEach((track) => track.stop());

        if (mounted.current) {
          setError("Recording failed. Please try again.");
          changePhase("idle");
        }
      };

      media.onstop = () => {
        input.getTracks().forEach((track) => track.stop());

        if (!mounted.current || failed) return;

        const audio = new Blob(chunks, {
          type: media.mimeType,
        });

        if (!audio.size) {
          setError("No audio was captured. Please try again.");
          changePhase("idle");
          return;
        }

        setUrl(URL.createObjectURL(audio));
        changePhase("ready");
        callbacks.current.onRecorded(audio);
      };

      media.start();
      changePhase("recording");
    } catch (e) {
      stream.current?.getTracks().forEach((track) => track.stop());

      if (mounted.current) {
        setError(e.message || "Microphone permission was denied.");
        changePhase("idle");
      }
    }
  }

  const pending =
    status === "permission" || status === "stopping";

  const statusText =
    status === "recording"
      ? "Listening..."
      : status === "permission"
        ? "Waiting for microphone permission…"
        : status === "stopping"
          ? "Preparing recording…"
          : status === "ready"
            ? "Recording ready."
            : "Microphone is off.";

  return (
    <div className="recorder">
      <MicrophoneIcon />

      <p role="status">{statusText}</p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {status === "recording" ? (
        <button
          className="stop"
          onClick={() => {
            changePhase("stopping");
            recorder.current.stop();
          }}
        >
          Stop recording
        </button>
      ) : (
        <button disabled={disabled || pending} onClick={start}>
          {status === "ready" ? "Record again" : "Start recording"}
        </button>
      )}

      {url && (
        <audio
          controls
          src={url}
          aria-label="Listen to your recording"
        />
      )}
    </div>
  );
}

const guides = {
  account: [
    "Welcome!",
    "Enter a profile name or try the demo version to get started. You can end and restart these instructions at any time to better navigate the app.",
  ],
    notice: [
    "Before you begin",
    "Please read the notice on this page, then tick the box and press Continue, or try the demo.",
  ],
  home: [
    "Your voice profile",
    "Set up your voice profile to pick your phrases and record them. After submitting training, choose Speech recognition to test your model. You can rerecord phrases using Update voice profile.",
  ],
  setup: [
    "Personalize your profile",
    "Select how many times you wish to record each phrase. We have 6 premade phrases and recommend recording each phrase thrice for better accuracy, but once is fine as well! You can also add extra phrases that you frequently say. After done, press Start recording.",
  ],
  training: [
    "Record your phrases",
    "You can check how many recordings you need to do. You can also listen to the phrase and your own recording.",
  ],
  usage: [
    "Try your voice profile",
    "Start recording and recieve the top 3 possibilities for what you said. Select the closest match based on the previously entered phrases. If all are incorrect, you can record another attempt."
  ]
};

export default function App() {
  const [page, setPage] = useState("notice");
  const [user, setUser] = useState(null);
  const [username, setUsername] = useState("");
  const [isDemoSession, setIsDemoSession] = useState(false);
  const [hideDemoNotice, setHideDemoNotice] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [guide, setGuide] = useState(true);
  const [popup, setPopup] = useState(null);
  const [agreed, setAgreed] = useState(false);

  const [phrases, setPhrases] = useState([]);
  const [index, setIndex] = useState(0);
  const [session, setSession] = useState(null);
  const [trainingSubmitted, setTrainingSubmitted] = useState(false);

  const [repeats, setRepeats] = useState(3);
  const [customPhrases, setCustomPhrases] = useState([]);
  const [customInput, setCustomInput] = useState("");
  const [enrolled, setEnrolled] = useState([]);

  const [blob, setBlob] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [version, setVersion] = useState(0);

  const [modelStatus, setModelStatus] = useState("none");
  const [choices, setChoices] = useState([]);
  const [selected, setSelected] = useState(null);

  
  const heading = useRef(null);

  const captureActive = [
    "recording",
    "permission",
    "stopping",
  ].includes(phase);

  const canTestSpeech =
    modelStatus === "submitted" ||
    modelStatus === "ready" ||
    (isDemoSession && modelStatus === "demo");

  useEffect(() => {
    heading.current?.focus();
  }, [page]);

  useEffect(() => {
    window.speechSynthesis?.cancel();

    return () => window.speechSynthesis?.cancel();
  }, [page, index]);

  function navigate(next) {
    setError("");
    setBlob(null);
    setPhase("idle");
    setChoices([]);
    setSelected(null);
    setVersion((value) => value + 1);
    setPage(next);
    setPopup(guide && next !== "home" ? "guide" : null);  
  }

  function endInstructions() {
    setGuide(false);
    setPopup(null);
  }

  function authenticate(e) {
    e.preventDefault();

    const profileName = username.trim();

    if (!profileName) {
      setError("Enter a name");
      return;
    }

    setUser({ username: profileName });
    setIsDemoSession(false);
    setModelStatus("none");
    setTrainingSubmitted(false);
    navigate("home");
  }

  function startDemo() {
    setUser({ username: "Demo" });
    setIsDemoSession(true);
    setModelStatus("none");
    setTrainingSubmitted(false);
    navigate("home");
    setHideDemoNotice(false);
  }

  function hearPhrase() {
    if (
      !window.speechSynthesis ||
      !window.SpeechSynthesisUtterance
    ) {
      setError("Phrase playback is not supported by this browser.");
      return;
    }

    window.speechSynthesis.cancel();

    const speech = new SpeechSynthesisUtterance(
      phrases[index].text
    );

    speech.lang = "en-US";
    speech.rate = 0.85;

    speech.onerror = (event) => {
      if (
        event.error !== "canceled" &&
        event.error !== "interrupted"
      ) {
        setError("Phrase playback failed. Please try again.");
      }
    };

    window.speechSynthesis.speak(speech);
  }

  function train() {
    if (!user?.username) {
      setError("Choose a profile name first.");
      return;
    }

    navigate("setup");
  }

  function addCustomPhrase(e) {
    e.preventDefault();

    const text = customInput.trim().replace(/\s+/g, " ");

    if (!text) return;

    const existing = [...trainingPhrases, ...customPhrases].map((p) =>
      p.text.toLowerCase()
    );

    if (existing.includes(text.toLowerCase())) {
      setError("That phrase is already in the list.");
      return;
    }

    if (customPhrases.length >= 10) {
      setError("You can add up to 10 custom phrases.");
      return;
    }

    setError("");
    setCustomPhrases((list) => [
      ...list,
      { id: `c${Date.now()}`, text },
    ]);
    setCustomInput("");
  }

  function removeCustomPhrase(id) {
    setCustomPhrases((list) => list.filter((p) => p.id !== id));
  }

  function beginRecording() {
    const queue = [...trainingPhrases, ...customPhrases].flatMap((p) =>
      Array.from({ length: repeats }, (_, i) => ({
        id: `${p.id}-${i + 1}`,
        text: p.text,
        take: i + 1,
        takes: repeats,
      }))
    );

    setSession(`recordings-${Date.now()}`);
    setPhrases(queue);
    setIndex(0);
    setTrainingSubmitted(false);
    setModelStatus("none");
    navigate("training");
  }

    async function savePhrase() {
    if (!blob || phase !== "ready") return;

    const isLast = index + 1 === phrases.length;

    setBusy(true);
    setError("");

    try {
      if (!isDemoSession) {
        const form = new FormData();

        form.append("user_id", user.username);
        form.append("phrase", phrases[index].text);
        form.append("audio", await toWav(blob), "recording.wav");

        await request("/enroll", {
          method: "POST",
          body: form,
        });

        if (isLast) {
          const body = new URLSearchParams();
          body.set("user_id", user.username);

          await request("/train", {
            method: "POST",
            body,
          });
        }
      }

        if (isLast) {
        setEnrolled(
          Array.from(new Set(phrases.map((p) => p.text))).map((text) => ({
            text,
            takes: repeats,
          }))
        );
        setTrainingSubmitted(!isDemoSession);
        setModelStatus(isDemoSession ? "demo" : "submitted");
        navigate("home");
      } else {
        setIndex((value) => value + 1);
        setBlob(null);
        setPhase("idle");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function findMatches() {
    if (!blob || phase !== "ready") return;

    setBusy(true);
    setError("");
    setSelected(null);
    setChoices([]);

    try {
      let data;

      if (isDemoSession) {
        data = {
          candidates: [...trainingPhrases, ...customPhrases].map(
            (p, i) => ({
              id: `d${i}`,
              text: p.text,
            })
          ),
        };
      } else {
        const form = new FormData();

        form.append("user_id", user.username);
        form.append("audio", await toWav(blob), "recording.wav");

        data = await request("/predict", {
          method: "POST",
          body: form,
        });

        console.log("Prediction API response:", data);
      }

      if (Array.isArray(data?.predictions)) {
        data = {
          candidates: [...data.predictions]
            .sort((a, b) => b.confidence - a.confidence)
            .map((p, i) => ({
              id: `m${i}`,
              text: p.phrase,
              confidence: p.confidence,
            })),
        };
      }

      if (!Array.isArray(data?.candidates)) {
        throw new Error(
          "The API responded, but its result format does not match " +
            "the app yet. Copy this response so we can adapt the UI: " +
            JSON.stringify(data)
        );
      }

      const candidates = data.candidates.slice(0, 3);

      if (
        candidates.some(
          (candidate) =>
            !candidate ||
            typeof candidate.text !== "string" ||
            candidate.id == null
        )
      ) {
        throw new Error(
          "The API candidates do not have the expected id and text " +
            "fields. Response: " +
            JSON.stringify(data)
        );
      }

      setChoices(candidates);

      if (!candidates.length) {
        setError("No matches were found. Please try again.");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function choose(candidate) {
    setError("");
    setSelected(candidate.id);
  }

  function retry() {
    setVersion((value) => value + 1);
    setBlob(null);
    setPhase("idle");
    setChoices([]);
    setSelected(null);
    setError("");
  }

   function logout() {
    setUser(null);
    setIsDemoSession(false);
    setUsername("");
    setModelStatus("none");
    setTrainingSubmitted(false);
    setPhrases([]);
    setIndex(0);
    setSession(null);
    setCustomPhrases([]);
    setCustomInput("");
    setEnrolled([]);
    navigate("account");
  }

  function handlePhase(value) {
    setPhase(value);

    if (value === "permission" || value === "recording") {
      setBlob(null);
      setChoices([]);
      setSelected(null);
      setError("");
    }
  }

  const popupTitle =
    popup === "finished"
      ? isDemoSession
        ? "Demo complete"
        : "Training request completed"
        : popup === "done"
          ? "Speech attempt complete"
          : guides[page][0];

  const popupText =
    popup === "finished"
      ? "Your voice profile is ready. Continue to Home to test speech recognition."
      : popup === "choices"
        ? "Choose the text that best matches what you meant. If none fit, press Record another attempt."
        : popup === "done"
          ? "Your choice is highlighted. Record another attempt or return Home."
          : guides[page][1];

  return (
    <main className="app-shell">
      <header className="topbar">
          <h1 className="brand">
          {user ? (
            <button
              type="button"
              className="brand-button"
              aria-label="Phonema, go to home"
              disabled={busy || captureActive}
              onClick={() => navigate("home")}
            >
              <img src="/FinalPhonema.png" alt="" className="brand-logo" />
            </button>
          ) : (
            <img src="/FinalPhonema.png" alt="Phonema" className="brand-logo" />
          )}
        </h1>

        <nav aria-label="App controls">
          {user && (
            <button
              className="secondary"
              disabled={busy || captureActive}
              onClick={() => navigate("home")}
            >
              Home
            </button>
          )}

            {page !== "home" && page !== "notice" && (
            <button
              className="secondary"
              onClick={() => {
                if (guide) {
                  endInstructions();
                } else {
                  setGuide(true);
                  setPopup("guide");
                }
              }}
            >
              {guide ? "End instructions" : "Restart instructions"}
            </button>
          )}

          {guide && page !== "home" && page !== "notice" && (
            <button
              className="secondary"
              onClick={() => setPopup("guide")}
            >
              Show instructions
            </button>
          )}

          {user && (
            <button
              className="secondary"
              disabled={busy || captureActive}
              onClick={logout}
            >
              Change profile
            </button>
          )}
        </nav>
      </header>
      
{isDemoSession && page !== "account" && !hideDemoNotice && (
  <div className="demo-notice">
    <p>
      <strong>Demo only:</strong> These recordings are not uploaded, and
      the speech predictions are preset examples rather than actual results.
    </p>

    <button
      type="button"
      className="dismiss-demo"
      aria-label="Dismiss demo notification"
      onClick={() => setHideDemoNotice(true)}
    >
      ×
    </button>
  </div>
)}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
            {page === "notice" && (
        <section className="card notice-card">
          <h2 ref={heading} tabIndex={-1}>
            Before you begin
          </h2>

          <p>Please read this before using Phonema.</p>

          <ul className="notice-list">
            <li>
              Your voice recordings are used to train our speech model
              every time you use the app.
            </li>
            <li>
            There are no accounts or passwords. The profile name is
              only used to get started and is not saved as an account.
            </li>
            <li>
              Because there are no accounts, you cannot view, change, or
              delete your recordings afterward.
            </li>
            <li>
              Please don't use your real name or personal details as
              your profile name.
            </li>
            <li>
              Prefer not to share recordings? Choose the demo below. It
              does not upload anything.
            </li>
          </ul>

          <label className="option">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              <strong>I understand and agree to these terms.</strong>
            </span>
          </label>

          <button disabled={!agreed} onClick={() => navigate("account")}>
            Continue
          </button>

          {DEMO_MODE && (
            <button className="secondary" onClick={startDemo}>
              Try demo without uploading recordings
            </button>
          )}
        </section>
      )}
      {page === "account" && (
        <section className="card account-card">
          <h2 ref={heading} tabIndex={-1}>
            Create a voice profile
          </h2>


          <form onSubmit={authenticate}>
            <label htmlFor="username">Profile name</label>

            <input
              id="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />

            <button disabled={busy}>Continue</button>
          </form>

          {DEMO_MODE && (
            <button
              className="secondary"
              disabled={busy}
              onClick={startDemo}
            >
              Try demo without uploading recordings
            </button>
          )}
        </section>
      )}

      {page === "home" && (
        <section className="card home-card">
          <div className="home-heading">
            <p className="section-label">Your profile</p>

            <h2 ref={heading} tabIndex={-1}>
              Welcome, {user?.username}
            </h2>
          </div>

            <div className="home-actions">
            <button
              className="home-action profile-action"
              disabled={busy}
              onClick={train}
            >
              <span className="action-title">
                {modelStatus === "none"
                  ? "Set up your voice profile"
                  : "Update voice profile"}
              </span>
            </button>

            {canTestSpeech && (
              <button
                className="home-action recognition-action"
                disabled={busy}
                onClick={() => navigate("usage")}
              >
                <span className="action-title">
                  Speech recognition
                </span>
              </button>
            )}
          </div>
          {enrolled.length > 0 && (
            <div className="enrolled">
              <h3>
                Your enrolled phrases
                <span className="enrolled-count">{enrolled.length}</span>
              </h3>

              <ul className="enrolled-list">
                {enrolled.map((p) => (
                  <li key={p.text}>
                    <span>{p.text}</span>
                    <span className="enrolled-take">
                      {p.takes === 1 ? "1 recording" : `${p.takes} recordings`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

        </section>
      )}

      {page === "setup" && (
        <section className="card setup-card">
          <h2 ref={heading} tabIndex={-1}>
            Personalize your profile
          </h2>

          <fieldset className="option-group">
            <legend>Recordings per phrase</legend>

            <label className="option">
              <input
                type="radio"
                name="repeats"
                checked={repeats === 3}
                onChange={() => setRepeats(3)}
              />
              <span>
                <strong>Three times (recommended)</strong> 
              </span>
            </label>

            <label className="option">
              <input
                type="radio"
                name="repeats"
                checked={repeats === 1}
                onChange={() => setRepeats(1)}
              />
              <span>
                <strong>Once</strong>
              </span>
            </label>
          </fieldset>

          <h3>Add your own phrases (optional)</h3>

          <form onSubmit={addCustomPhrase}>
            <label htmlFor="custom-phrase">Your phrase</label>

            <input
              id="custom-phrase"
              maxLength={80}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
            />

            <button
              type="submit"
              className="secondary"
              disabled={!customInput.trim()}
            >
              Add phrase
            </button>
          </form>

          {customPhrases.length > 0 && (
            <ul className="custom-list">
              {customPhrases.map((p) => (
                <li key={p.id}>
                  <span>{p.text}</span>

                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Remove ${p.text}`}
                    onClick={() => removeCustomPhrase(p.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button onClick={beginRecording}>Start recording</button>
        </section>
      )}

      {page === "training" && (
        <section className="training-layout">
          <div className="card">
            <p>
              Recording {index + 1} of {phrases.length}
              {phrases[index].takes > 1 &&
                ` · Take ${phrases[index].take} of ${phrases[index].takes}`}
            </p>

            <h2 ref={heading} tabIndex={-1}>
              Record the phrase:
            </h2>

            <blockquote className="phrase">
              “{phrases[index].text}”
            </blockquote>

            <button
              className="secondary hear-phrase"
              disabled={busy || captureActive}
              onClick={hearPhrase}
            >
              Hear the phrase
            </button>
          </div>

          <div className="card">
            <Recorder
              key={`${session}-${index}`}
              disabled={busy}
              onPhase={handlePhase}
              onRecorded={setBlob}
            />

            <button
              disabled={!blob || busy || phase !== "ready"}
              onClick={savePhrase}
            >
              {busy
                ? index + 1 === phrases.length
                  ? "Training your voice profile…"
                  : "Saving…"
                : index + 1 === phrases.length
                  ? "Train and finish"
                  : "Save and next"}
            </button>
          </div>
        </section>
      )}

      {page === "usage" && (
        <section className="split-layout">
          <div className="card speech-panel">
            <h2 ref={heading} tabIndex={-1}>
              {phase === "recording"
                ? "Listening…"
                : "Ready to listen"}
            </h2>

            <div className="bottom-controls">
              <Recorder
                key={version}
                disabled={busy}
                onPhase={handlePhase}
                onRecorded={setBlob}
              />

              <button
                disabled={!blob || busy || phase !== "ready"}
                onClick={findMatches}
              >
                {busy ? "Please wait…" : "Find matches"}
              </button>
            </div>
          </div>

          <div className="card choices-panel">
            <h2>Suggested matches</h2>

            {choices.length > 0 && (
              <p className="choices-hint">
                Listed from most likely to least likely.
              </p>
            )}
            {choices.length ? (
              choices.map((candidate, i) => {
                const isSelected = selected === candidate.id;

                return (
                  <button
                    key={candidate.id}
                    className={
                      isSelected
                        ? "choice selected-choice"
                        : "choice"
                    }
                    aria-pressed={isSelected}
                    aria-describedby={
                      isSelected
                        ? "selected-match-status"
                        : undefined
                    }
                    disabled={busy || captureActive}
                    onClick={() => choose(candidate)}
                  >
                    <span className="choice-rank" aria-hidden="true">
                      {i + 1}
                    </span>

                    <span className="choice-text">
                      <span className="visually-hidden">
                        Match {i + 1}:{" "}
                      </span>
                      {candidate.text}
                      {i === 0 && (
                        <span className="choice-tag">Most likely</span>
                      )}
                    </span>

                    <span
                      className="choice-indicator"
                      aria-hidden="true"
                    >
                      {isSelected && (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 12l4 4L19 6" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })
            ) : null}

            <span
              id="selected-match-status"
              className="visually-hidden"
              role="status"
            >
              {selected !== null ? "Match selected." : ""}
            </span>

             {choices.length > 0 && (
              <button
                className="secondary"
                disabled={busy || captureActive}
                onClick={retry}
              >
                Record another attempt
              </button>
            )}
          </div>
        </section>
      )}

      {popup && (
        <Popup
          title={popupTitle}
          onClose={() => setPopup(null)}
          onEnd={popup === "finished" ? null : endInstructions}
          label={
            popup === "finished" ? "Continue to home" : "Got it"
          }
        >
          <p>{popupText}</p>
        </Popup>
      )}
    </main>
  );
}