import torch
import torch.nn as nn

class AttentionPooling(nn.Module):
    def __init__(self, hidden_dim=768):
        super().__init__()
        self.attention = nn.Linear(hidden_dim, 1)

    def forward(self, hidden_states, mask=None):
        scores = self.attention(hidden_states)

        if mask is not None:
            scores = scores.masked_fill(mask.unsqueeze(-1) == 0, float('-inf'))

        weights = torch.softmax(scores, dim=1)
        pooled = (hidden_states * weights).sum(dim=1)
        return pooled


class PhraseClassifier(nn.Module):
    def __init__(self, hidden_dim=768, num_classes=None, use_attention_pooling=True):
        super().__init__()
        self.use_attention_pooling = use_attention_pooling
        if use_attention_pooling:
            self.pooling = AttentionPooling(hidden_dim)

        self.classifier = nn.Sequential(
            nn.Linear(hidden_dim, 128),
            nn.ReLU(),
            nn.Dropout(0.5),
            nn.Linear(128, num_classes)
        )

    def forward(self, hidden_states, mask=None):
        if self.use_attention_pooling:
            pooled = self.pooling(hidden_states, mask)
        else:
            pooled = hidden_states.mean(dim=1)
        return self.classifier(pooled)

class EndToEndPhraseModel(nn.Module):
    def __init__(self, wav2vec_model, num_classes, hidden_dim=768):
        super().__init__()
        self.wav2vec = wav2vec_model
        self.pooling = AttentionPooling(hidden_dim)
        self.classifier = nn.Sequential(
            nn.Linear(hidden_dim, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, num_classes)
        )

    def forward(self, input_values, attention_mask=None):
        outputs = self.wav2vec(input_values, attention_mask=attention_mask)
        hidden_states = outputs.last_hidden_state
        pooled = self.pooling(hidden_states)
        return self.classifier(pooled)
