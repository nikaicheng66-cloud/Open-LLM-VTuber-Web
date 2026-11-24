import { useState } from 'react';
import { useWebSocket } from '@/context/websocket-context';
import { useAiState } from '@/context/ai-state-context';
import { useInterrupt } from '@/components/canvas/live2d';
import { useChatHistory } from '@/context/chat-history-context';
import { useMediaCapture } from '@/hooks/utils/use-media-capture';
import { PetPicture, PICTURE_ONLY_TEXT } from '@/utils/pet-pictures';

export function useTextInput() {
  const [inputText, setInputText] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const wsContext = useWebSocket();
  const { aiState } = useAiState();
  const { interrupt } = useInterrupt();
  const { appendHumanMessage } = useChatHistory();
  const { captureAllMedia } = useMediaCapture();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value);
  };

  // [deskpet] one path for the typing box, the quick-prompt chips and pictures given to her:
  // all go out as `text-input`; pictures ride along in `images` (a picture alone gets a few words)
  const sendText = async (raw: string, pictures: PetPicture[] = []) => {
    const text = raw.trim() || (pictures.length ? PICTURE_ONLY_TEXT : '');
    if (!text || !wsContext) return;
    if (aiState === 'thinking-speaking') {
      interrupt();
    }

    const images = [
      ...await captureAllMedia(),
      ...pictures.map(({ source, data, mime_type }) => ({ source, data, mime_type })),
    ];

    appendHumanMessage(text, pictures.map((p) => p.thumb));
    wsContext.sendMessage({
      type: 'text-input',
      text,
      images,
    });
  };

  const handleSend = async () => {
    if (!inputText.trim()) return;
    await sendText(inputText);
    // [deskpet] typing to her must not switch the microphone off (she would stop hearing her name)
    setInputText('');
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposing) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCompositionStart = () => setIsComposing(true);
  const handleCompositionEnd = () => setIsComposing(false);

  return {
    inputText,
    setInputText: handleInputChange,
    handleSend,
    sendText,
    setInputTextRaw: setInputText,
    handleKeyPress,
    handleCompositionStart,
    handleCompositionEnd,
  };
}
