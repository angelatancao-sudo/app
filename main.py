from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
import torch
import scipy.signal
import numpy as np
import io
import os
import json

from speech_models_utils import EndToEndPhraseModel, AttentionPooling, PhraseClassifier
from peft import PeftModel
from transformers import Wav2Vec2Model, Wav2Vec2Processor

app = FastAPI()

# lets your friend's frontend (running on a different URL) actually call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # fine for a hackathon/demo; restrict later if needed
    allow_methods=["*"],
    allow_headers=["*"],
)

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
processor = Wav2Vec2Processor.from_pretrained("facebook/wav2vec2-base-960h")

# load your FROZEN encoder ONCE at startup (not per-request — too slow)
base_model = Wav2Vec2Model.from_pretrained("facebook/wav2vec2-base-960h")
base_model.config.apply_spec_augment = False
lora_wav2vec = PeftModel.from_pretrained(base_model, "saved_models/chosen_adapter").to(device)
lora_wav2vec.eval()

# in-memory storage of each user's enrollment data + trained classifier
# (fine for a demo; a real product would use a database)
user_data = {}       # { user_id: [ {phrase, audio_array}, ... ] }
user_models = {}     # { user_id: trained classifier }
all_transcripts_per_user = {}  # { user_id: [phrase1, phrase2, ...] }


# def load_audio_from_upload(file_bytes):
    # audio, sr = librosa.load(io.BytesIO(file_bytes), sr=16000)
    # return audio

import soundfile as sf
import numpy as np

def load_audio_from_upload(file_bytes):
    audio, sr = sf.read(io.BytesIO(file_bytes))

    # soundfile doesn't resample automatically like librosa.load(sr=16000) did —
    # if the incoming audio isn't already 16kHz, resample it manually
    if sr != 16000:
        import scipy.signal
        num_samples = int(len(audio) * 16000 / sr)
        audio = scipy.signal.resample(audio, num_samples)

    # soundfile can return stereo (2D) audio; wav2vec2 expects mono
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    return audio.astype(np.float32)


@app.post("/enroll")
async def enroll(user_id: str = Form(...), phrase: str = Form(...), audio: UploadFile = File(...)):
    audio_bytes = await audio.read()
    audio_array = load_audio_from_upload(audio_bytes)

    if user_id not in user_data:
        user_data[user_id] = []
    user_data[user_id].append({"phrase": phrase, "audio": audio_array})

    return {"status": "recorded", "phrase": phrase,
            "total_recordings_for_phrase": sum(1 for e in user_data[user_id] if e["phrase"] == phrase)}


@app.post("/train")
async def train(user_id: str = Form(...)):
    if user_id not in user_data or len(user_data[user_id]) == 0:
        return {"status": "error", "message": "no enrollment data found"}

    entries = user_data[user_id]
    transcripts = sorted(set(e["phrase"] for e in entries))
    label_to_idx = {t: i for i, t in enumerate(transcripts)}
    all_transcripts_per_user[user_id] = transcripts

    # get embeddings for every enrolled recording using the frozen encoder
    embeddings = []
    for entry in entries:
        inputs = processor(entry["audio"], sampling_rate=16000, return_tensors="pt")
        input_values = inputs.input_values.to(device)
        with torch.no_grad():
            hidden_states = lora_wav2vec(input_values).last_hidden_state.squeeze(0).cpu()
        embeddings.append({"hidden_states": hidden_states, "label": label_to_idx[entry["phrase"]]})

    # train small classifier
    model_head = PhraseClassifier(num_classes=len(transcripts)).to(device)
    optimizer = torch.optim.Adam(model_head.parameters(), lr=1e-3, weight_decay=1e-4)
    criterion = torch.nn.CrossEntropyLoss()

    for epoch in range(30):
        for e in embeddings:
            hs = e["hidden_states"].unsqueeze(0).to(device)
            label = torch.tensor([e["label"]]).to(device)
            optimizer.zero_grad()
            logits = model_head(hs)
            loss = criterion(logits, label)
            loss.backward()
            optimizer.step()

    user_models[user_id] = model_head
    return {"status": "trained", "num_phrases": len(transcripts), "num_recordings": len(entries)}


@app.post("/predict")
async def predict(user_id: str = Form(...), audio: UploadFile = File(...)):
    if user_id not in user_models:
        return {"status": "error", "message": "user not trained yet"}

    audio_bytes = await audio.read()
    audio_array = load_audio_from_upload(audio_bytes)

    inputs = processor(audio_array, sampling_rate=16000, return_tensors="pt")
    input_values = inputs.input_values.to(device)
    with torch.no_grad():
        hidden_states = lora_wav2vec(input_values).last_hidden_state.to(device)
        logits = user_models[user_id](hidden_states)
        probs = torch.softmax(logits, dim=1)
        top5 = probs.topk(min(5, probs.shape[1]), dim=1)

    transcripts = all_transcripts_per_user[user_id]
    predictions = [
        {"phrase": transcripts[idx], "confidence": float(conf)}
        for conf, idx in zip(top5.values[0].tolist(), top5.indices[0].tolist())
    ]
    return {"predictions": predictions}
