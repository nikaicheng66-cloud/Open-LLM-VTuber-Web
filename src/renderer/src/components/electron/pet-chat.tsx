// [deskpet] Pet-mode chat: one small speech bubble beside her head that holds the whole exchange -
// what the user said, what she says ("正在思考…" while she thinks, "正在听…" while the microphone
// hears speech), a row of quick-prompt chips, the typing box and a "to tray" button. The bubble
// follows her around and flips to the side of the screen that has room.
// Pictures for her to look at: paste one into the typing box (a screenshot from Win+Shift+S works),
// drop one on the bubble, or pick one with the picture button; they wait above the typing box until
// Enter sends them with whatever was typed.
import { LuImage, LuPanelBottomClose, LuPencil, LuX } from 'react-icons/lu';
import { Box, Flex, Input, IconButton, Textarea } from '@chakra-ui/react';
import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { useInputSubtitle } from '@/hooks/electron/use-input-subtitle';
import { useDraggable } from '@/hooks/electron/use-draggable';
import { useMode } from '@/context/mode-context';
import { petActions, PetScreenRect } from '@/utils/pet-actions';
import {
  WaitingPicture, PictureSource, MAX_PICTURES, isPicture, readPictures, preparePictures, onAttachToBubble,
} from '@/utils/pet-pictures';

const W = 236; // bubble width
const GAP = 12; // between her and the bubble
const EDGE = 6; // keep this far from the screen edge
const AI_MS = 45000; // how long her last words stay up once she is quiet

const DEFAULT_PROMPTS = ['继续投递', '看看进度', '今天投了几个', '停一下', '过来', '躲起来', '休息一下'];
const PROMPTS_KEY = 'deskpet-quick-prompts';
const GLASS = 'rgba(255,255,255,0.42)';
const GLASS_IN = 'rgba(255,255,255,0.55)';
const GLASS_TEXT = 'rgba(255,255,255,0.62)'; // behind her words, so they read on any desktop

function loadPrompts(): string[] {
  try {
    const raw = localStorage.getItem(PROMPTS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
    }
  } catch { /* ignore */ }
  return DEFAULT_PROMPTS;
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? lo : Math.min(Math.max(v, lo), hi));

// Where she is, refreshed ~10 times a second; only re-renders when she actually moved.
function usePetRect(): PetScreenRect | null {
  const [rect, setRect] = useState<PetScreenRect | null>(null);
  useEffect(() => {
    let last: PetScreenRect | null = null;
    const tick = () => {
      const r = petActions.screenRect();
      const moved = !r || !last
        || Math.abs(r.headX - last.headX) > 1 || Math.abs(r.headY - last.headY) > 1
        || Math.abs(r.left - last.left) > 1 || Math.abs(r.bottom - last.bottom) > 1;
      if (moved) {
        last = r;
        setRect(r);
      }
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, []);
  return rect;
}

export function PetChat() {
  const {
    inputValue,
    handleInputChange,
    handleKeyPress,
    handleCompositionStart,
    handleCompositionEnd,
    aiState,
    messages,
    sendText,
    setInputTextRaw,
  } = useInputSubtitle();

  const { mode } = useMode();
  const isPet = mode === 'pet';
  const rect = usePetRect();

  // hover bookkeeping only (the bubble follows her, it is not dragged any more)
  const { elementRef, handleMouseEnter, handleMouseLeave } = useDraggable({ componentId: 'input-subtitle' });

  // [deskpet] remembered across restarts; reopen from the tray icon ("显示/隐藏输入框")
  const [isVisible, setIsVisible] = useState(() => {
    try { return localStorage.getItem('deskpet-input-hidden') !== '1'; } catch { return true; }
  });

  const releaseHover = useCallback(() => {
    if (isPet) (window.api as any)?.updateComponentHover('input-subtitle', false);
  }, [isPet]);

  const handleClose = useCallback(() => {
    releaseHover();
    setIsVisible(false);
    try { localStorage.setItem('deskpet-input-hidden', '1'); } catch { /* ignore */ }
  }, [releaseHover]);

  const handleOpen = () => {
    setIsVisible(true);
    try { localStorage.setItem('deskpet-input-hidden', '0'); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (isPet) {
      const cleanup = (window.api as any)?.onToggleInputSubtitle(() => {
        if (isVisible) handleClose();
        else handleOpen();
      });
      return () => cleanup?.();
    }
    return () => {};
  }, [handleClose, isPet, isVisible]);

  useEffect(() => {
    (window as any).inputSubtitle = { open: handleOpen, close: handleClose };
    return () => { delete (window as any).inputSubtitle; };
  }, [isPet, handleClose]);

  // whole window to the tray (the main process hides instead of closing)
  const toTray = () => {
    releaseHover();
    (window as any).electron?.ipcRenderer.send('window-close');
  };

  // ---- quick prompts -------------------------------------------------------------------------
  const [prompts, setPrompts] = useState<string[]>(loadPrompts);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const openEditor = () => { setDraft(prompts.join('\n')); setEditing(true); };
  const saveEditor = () => {
    const list = draft.split('\n').map((s) => s.trim()).filter(Boolean);
    const next = list.length ? list : DEFAULT_PROMPTS;
    setPrompts(next);
    try { localStorage.setItem(PROMPTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setEditing(false);
  };
  const onChip = (p: string, e: React.MouseEvent) => {
    if (e.shiftKey) setInputTextRaw(p); // shift+click: put it in the box to edit first
    else sendText(p); // click: send straight away, same path as the typing box
  };

  // ---- pictures waiting to be sent ------------------------------------------------------------
  const [pending, setPending] = useState<WaitingPicture[]>([]);
  const pendingNow = useRef(pending); // for the handlers that outlive a render
  pendingNow.current = pending;
  const [pictureNote, setPictureNote] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const flash = (text: string) => {
    clearTimeout(noteTimer.current);
    setPictureNote(text);
    noteTimer.current = setTimeout(() => setPictureNote(''), 5000);
  };
  const addFiles = async (files: Blob[], source: PictureSource) => {
    const { waiting, failed } = await readPictures(files, source, MAX_PICTURES - pendingNow.current.length);
    setPending((prev) => [...prev, ...waiting].slice(0, MAX_PICTURES));
    if (failed) flash(waiting.length ? '有的图片没放进来（打不开，或超过四张）。' : '这张图片放不进来（打不开，或已经有四张）。');
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(isPicture);
    if (!files.length) return; // ordinary text
    e.preventDefault();
    addFiles(files, 'clipboard');
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // the same file can be picked again
    if (files.length) addFiles(files, 'upload');
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (pending.length && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const words = inputValue;
      const going = pending;
      setInputTextRaw('');
      setPending([]);
      // shrunk now, together: the pictures of one message share what her model can take in
      preparePictures(going)
        .then(({ pictures }) => {
          if (pictures.length) sendText(words, pictures); // no words: she is simply asked to look
          else flash('图片没发出去，再放一次试试。');
        })
        .catch(() => flash('图片没发出去，再放一次试试。'));
      return;
    }
    handleKeyPress(e);
  };
  // dropped on the bubble (audio-drop.tsx): keep them here for the user's question
  useEffect(() => onAttachToBubble((files) => {
    addFiles(files, 'upload');
    inputRef.current?.focus();
  }), []);
  useEffect(() => () => clearTimeout(noteTimer.current), []);

  // ---- what the bubble shows ------------------------------------------------------------------
  const lastHuman = [...messages].reverse().find((m) => m.role === 'human');
  const lastAI = [...messages].reverse().find((m) => m.role === 'ai' && m.type !== 'tool_call_status' && m.content?.trim());
  const humanIdx = lastHuman ? messages.lastIndexOf(lastHuman) : -1;
  const aiIdx = lastAI ? messages.lastIndexOf(lastAI) : -1;
  const awaitingReply = humanIdx > aiIdx; // she has not said anything since the user's last words

  let status: string | null = null;
  if (aiState === 'listening') status = '正在听…';
  else if (aiState === 'loading') status = '加载中…';
  else if (aiState === 'thinking-speaking' && awaitingReply) status = '正在思考…';

  // old words fade out after a while when nothing is happening
  const [now, setNow] = useState(Date.now());
  const aiAt = useRef(0);
  const aiLen = useRef(0);
  useEffect(() => {
    if (lastAI && lastAI.content.length !== aiLen.current) {
      aiLen.current = lastAI.content.length;
      aiAt.current = Date.now();
    }
  }, [aiIdx, lastAI?.content]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const busy = aiState === 'thinking-speaking' || aiState === 'listening';
  const showAI = !!lastAI && !awaitingReply && (busy || now - aiAt.current < AI_MS);
  const aiText = status || (showAI && lastAI ? lastAI.content : '');

  // [deskpet] sent to the tray she still listens; the window comes back the moment she starts
  // answering someone (services/websocket-handler.tsx, on 'conversation-chain-start').

  // ---- where the bubble goes: beside her head, on the side with room (right first) ------------
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const boxRef = useRef<HTMLDivElement>(null);
  let side: 'left' | 'right' = 'right';
  if (rect) {
    const roomRight = vw - rect.right - GAP - EDGE;
    const roomLeft = rect.left - GAP - EDGE;
    if (roomRight < W && roomLeft > roomRight) side = 'left';
  }
  const left = rect
    ? side === 'right'
      ? clamp(rect.right + GAP, EDGE, vw - W - EDGE)
      : clamp(rect.left - GAP - W, EDGE, vw - W - EDGE)
    : vw / 2 - W / 2;

  // vertical: the tail (18px from the top) points at her head; keep the whole box on screen
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const top = rect ? rect.headY - 22 : vh - h - 120;
    const t = clamp(top, EDGE, vh - h - EDGE);
    el.style.top = `${t}px`;
    // the tail stays level with her head even when the box had to be pushed up/down
    const tail = el.querySelector('[data-tail]') as HTMLElement | null;
    if (tail) tail.style.top = `${rect ? clamp(rect.headY - t - 6, 10, h - 22) : 16}px`;
  });

  if (!isVisible) return null;

  const fg = 'gray.800';

  return (
    <Box
      ref={(el: HTMLDivElement | null) => {
        (elementRef as any).current = el;
        (boxRef as any).current = el;
      }}
      data-audio-drop
      data-pet-bubble
      position="fixed"
      left={`${left}px`}
      top="0px"
      w={`${W}px`}
      zIndex={1000}
      userSelect="none"
      transition="left 0.15s ease, top 0.15s ease"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      bg={GLASS}
      border="1px solid rgba(255,255,255,0.55)"
      color={fg}
      borderRadius="14px"
      boxShadow="0 2px 12px rgba(0,0,0,0.15)"
      css={{
        WebkitUserSelect: 'none',
        textShadow: '0 0 3px rgba(255,255,255,0.9), 0 0 1px rgba(255,255,255,0.9)',
        // while she is being dragged the bubble must not catch the mouse (it follows her head
        // and would otherwise slide under the cursor and steal the drag)
        'body[data-pet-dragging] &': { pointerEvents: 'none' },
      }}
      p="7px"
      fontSize="12px"
      lineHeight="1.4"
    >
      {/* tail pointing at her head */}
      <Box
        data-tail
        position="absolute"
        {...(side === 'right' ? { left: '-5px' } : { right: '-5px' })}
        top="16px"
        w="10px"
        h="10px"
        bg={GLASS}
        borderLeft="1px solid rgba(255,255,255,0.55)"
        borderBottom="1px solid rgba(255,255,255,0.55)"
        transform="rotate(45deg)"
        borderRadius="2px"
      />

      {/* only her side of the exchange: the user knows what they said */}
      {aiText && (
        <Box
          color={status ? 'gray.600' : 'gray.900'}
          fontStyle={status ? 'italic' : 'normal'}
          fontSize={status ? '12px' : '13px'}
          fontWeight={status ? 'normal' : '500'}
          lineHeight="1.5"
          bg={status ? 'transparent' : GLASS_TEXT}
          borderRadius="8px"
          px={status ? '2px' : '7px'}
          py={status ? '0' : '4px'}
          mb="6px"
          maxH="132px"
          overflowY="auto"
          css={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap', scrollbarWidth: 'thin' }}
        >
          {aiText}
        </Box>
      )}

      {/* quick prompts, like the suggestion chips in a phone app: one scrolling row */}
      {editing ? (
        <Box mb="5px">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            fontSize="11px"
            bg={GLASS_IN}
            borderColor="rgba(255,255,255,0.6)"
            placeholder="每行一个常用提示词"
            p="4px"
          />
          <Flex gap="2" mt="3px" justify="flex-end">
            <Box as="button" onClick={() => setEditing(false)} fontSize="11px" color="gray.500" px="6px">取消</Box>
            <Box as="button" onClick={saveEditor} fontSize="11px" color="white" bg="#3b82f6" px="8px" py="2px" borderRadius="999px">保存</Box>
          </Flex>
        </Box>
      ) : (
        <Flex
          gap="4px"
          rowGap="3px"
          mb="5px"
          align="center"
          wrap="wrap"
          overflow="hidden"
        >
          {prompts.map((p) => (
            <Box
              as="button"
              key={p}
              data-prompt-chip
              onClick={(e: React.MouseEvent) => onChip(p, e)}
              title="点击直接发送；Shift+点击填入输入框"
              fontSize="11px"
              color="gray.800"
              bg={GLASS_IN}
              _hover={{ bg: '#3b82f6', color: 'white' }}
              px="7px"
              py="1px"
              borderRadius="999px"
              whiteSpace="nowrap"
              maxW="100%"
              overflow="hidden"
              textOverflow="ellipsis"
              cursor="pointer"
            >
              {p}
            </Box>
          ))}
          <Box
            as="button"
            aria-label="编辑提示词"
            title="编辑提示词"
            onClick={openEditor}
            color="gray.400"
            _hover={{ color: 'gray.700' }}
            px="4px"
            flexShrink={0}
            cursor="pointer"
          >
            <LuPencil size={10} />
          </Box>
        </Flex>
      )}

      {/* pictures that go out with the next Enter */}
      {pending.length > 0 && (
        <Flex gap="4px" mb="5px" align="center" data-pending-pictures>
          {pending.map((pic, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <Box key={i} position="relative" flexShrink={0}>
              <img src={pic.thumb} alt="" style={{ height: 36, maxWidth: 56, borderRadius: 6, objectFit: 'cover', display: 'block' }} />
              <Box
                as="button"
                aria-label="不发这张"
                title="不发这张"
                onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
                position="absolute"
                top="-4px"
                right="-4px"
                w="14px"
                h="14px"
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg="rgba(0,0,0,0.6)"
                color="white"
                borderRadius="999px"
                cursor="pointer"
              >
                <LuX size={9} />
              </Box>
            </Box>
          ))}
        </Flex>
      )}
      {pictureNote && (
        <Box color="gray.500" fontSize="11px" px="2px" mb="4px">{pictureNote}</Box>
      )}

      {/* typing box + picture + to tray */}
      <Flex gap="4px" align="center">
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder={pending.length ? '想问什么？回车发送' : '跟小克说…'}
          size="xs"
          h="24px"
          flex="1"
          bg={GLASS_IN}
          color={fg}
          fontSize="12px"
          borderColor="rgba(255,255,255,0.6)"
          borderRadius="999px"
          px="8px"
          _placeholder={{ color: 'gray.400' }}
          _focus={{ borderColor: '#3b82f6', outline: 'none' }}
        />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPick} />
        <IconButton
          aria-label="给小克看图片"
          title="给小克看图片（也可以把截图粘贴进输入框，或把图片拖到她身上）"
          onClick={() => fileRef.current?.click()}
          size="2xs"
          variant="ghost"
          color="gray.500"
          _hover={{ bg: GLASS_IN, color: 'gray.900' }}
          borderRadius="999px"
        >
          <LuImage size={13} />
        </IconButton>
        <IconButton
          aria-label="缩小到系统托盘"
          title="缩小到系统托盘"
          onClick={toTray}
          size="2xs"
          variant="ghost"
          color="gray.500"
          _hover={{ bg: GLASS_IN, color: 'gray.900' }}
          borderRadius="999px"
        >
          <LuPanelBottomClose size={13} />
        </IconButton>
      </Flex>
    </Box>
  );
}
