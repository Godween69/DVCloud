import { AnimatePresence, motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, sendFile } from '../api';
import { useFeed } from '../lib/useFeed';
import { useQuickAlbum } from '../lib/quick';
import { UploadQueue, type UploadJob } from '../lib/uploader';
import { claimFile } from '../lib/claim';
import { filesFromDrop, filesFromInput, uploadable, type PickedFile } from '../lib/folders';
import { countFiles } from '../lib/format';
import { useTheme } from '../lib/theme';
import { MAX_ZIP_IDS, setMany, toggled } from '../lib/albums';
import type { Album, AlbumRef, Estimate, FileItem, Usage, User } from '../types';
import { QuotaDialog } from './QuotaDialog';
import { AlbumPicker, type PickResult } from './AlbumPicker';
import { AlbumHeader, AlbumsView } from './AlbumsView';
import { Gallery } from './Gallery';
import { SecurityView } from './SecurityView';
import { SelectionBar } from './SelectionBar';
import { ShareDialog } from './ShareDialog';
import { Toast, type ToastData } from './Toast';
import { TopBar, type View } from './TopBar';
import { SimilarView } from './SimilarView';
import { TrashView } from './TrashView';
import { UploadPanel } from './UploadPanel';
import { Viewer } from './Viewer';

export function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>('library');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [viewer, setViewer] = useState<{ id: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [overQuota, setOverQuota] = useState<{ est: Estimate; files: File[] } | null>(null);
  const toastId = useRef(0);

  const [album, setAlbum] = useState<Album | null>(null); // открытый альбом (внутри вкладки «Альбомы»)
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<string[] | null>(null); // что переносим в альбом из режима выбора
  const [sharing, setSharing] = useState(false); // окно «Поделиться альбомом»
  const [targetPicker, setTargetPicker] = useState(false); // окно выбора быстрого альбома

  const library = useFeed(false);
  const trash = useFeed(true);
  const albumFeed = useFeed(false, album?.id);
  const inAlbum = view === 'albums' && album !== null;
  const foreign = inAlbum && album !== null && !album.mine; // чужой общий альбом: только смотреть, сохранять, скачивать
  const active = inAlbum ? albumFeed : library; // из какой ленты листает просмотрщик

  const refreshUsage = useCallback(() => { api.usage().then(setUsage).catch(() => {}); }, []);
  const say = useCallback((text: string, action?: ToastData['action']) => setToast({ id: ++toastId.current, text, action }), []);
  const doneToast = useCallback(() => setToast(null), []);
  const quick = useQuickAlbum(say);

  const addLib = library.add;
  const queue = useMemo(
    () => new UploadQueue<File & { path?: string }>(sendFile, setJobs, (f, dup) => { if (!dup) addLib(f); refreshUsage(); }, 3, claimFile),
    [addLib, refreshUsage],
  );

  useEffect(() => { library.loadMore(true); refreshUsage(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { if (view === 'trash') trash.loadMore(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view]);
  const refreshAlbums = useCallback(() => { api.albums().then(setAlbums).catch(() => {}); }, []);
  useEffect(() => { if (view === 'albums' && !album) refreshAlbums(); }, [view, album, refreshAlbums]);
  useEffect(() => { if (album) albumFeed.loadMore(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [album?.id]);

  const endSelect = useCallback(() => { setSelecting(false); setSelected(new Set()); }, []);
  function changeView(v: View) {
    setView(v);
    setAlbum(null);
    endSelect();
  }

  function enqueue(files: File[]) {
    queue.add(files);
  }

  // Общий вход для кнопок и перетаскивания: папки раскрыты, лишнее отброшено, перед большой загрузкой сверяемся с квотой.
  async function startUpload(picked: PickedFile[]) {
    if (picked.length === 0) return;
    const many = picked.length > 5;
    const chosen = many ? uploadable(picked) : picked;
    if (many && chosen.length < picked.length) say(`Пропущено не фото и не видео: ${picked.length - chosen.length}`);
    if (chosen.length === 0) return;
    const files = chosen.map((p) => Object.assign(p.file, { path: p.path }) as File);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (many) {
      try {
        const est = await api.estimate(bytes);
        if (!est.fits) { setOverQuota({ est, files }); return; }
      } catch { /* оценка не получилась: грузим, квоту всё равно проверит сервер */ }
    }
    enqueue(files);
  }
  const startRef = useRef(startUpload);
  startRef.current = startUpload;

  async function askMore() {
    const o = overQuota;
    setOverQuota(null);
    if (!o) return;
    try {
      await api.quotaRequest(Math.max(1, o.est.needBytes - (o.est.freeBytes ?? 0)), `Нужно загрузить ${countFiles(o.files.length)}`);
      say('Просьба отправлена администратору');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось отправить просьбу');
    }
  }

  // Перетаскивание файлов в окно: счётчик нужен, потому что dragenter/leave срабатывают на вложенных элементах.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const dt = e.dataTransfer;
      if (dt) void filesFromDrop(dt).then((p) => startRef.current(p));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, [queue]);

  const openIndex = viewer ? active.files.findIndex((f) => f.id === viewer.id) : -1;
  useEffect(() => { if (viewer && openIndex === -1) setViewer(null); }, [viewer, openIndex]);

  // Файл ушёл из текущей ленты (в корзину или в другой альбом): просмотр переходит к соседнему.
  function leaveFeed(id: string) {
    const next = active.files[openIndex + 1] ?? active.files[openIndex - 1];
    // Функциональное обновление: если окно просмотра успели закрыть, пока шёл запрос, оно не открывается заново.
    setViewer((v) => (v && v.id === id && next ? { id: next.id } : v));
    active.remove(id);
  }

  async function toTrash(id: string) {
    const f = active.files.find((x) => x.id === id);
    if (!f) return;
    try {
      await api.trash(id);
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось скрыть');
      return;
    }
    // Соседний файл показываем вместо удалённого; если соседей нет, просмотрщик закроется сам.
    leaveFeed(id);
    if (inAlbum) library.remove(id);
    say('Файл скрыт', {
      label: 'Вернуть',
      run: () => { api.restore(id).then((r) => { library.add(r.file); refreshUsage(); }).catch(() => say('Не получилось вернуть файл')); },
    });
    refreshUsage();
  }

  // Быстрый альбом: положить файл (или убрать, если он там уже). Если файл из-за этого ушёл из открытого альбома, лента подправляется.
  async function quickFile(f: FileItem): Promise<'added' | 'moved' | null> {
    const t = quick.target;
    if (!t || quick.has(f.id)) return null;
    const r = await quick.toggle(f.id);
    if (r !== true) return null;
    return 'added';
  }

  async function quickTile(id: string) {
    const t = quick.target;
    if (!t) return;
    const r = await quick.toggle(id);
    if (r === false && inAlbum && album && album.id === t.id) albumFeed.remove(id);
  }

  async function quickSelected() {
    const t = quick.target;
    if (!t) return;
    const ids = [...selected];
    const n = await quick.addMany(ids);
    if (n === null) return;
    say(`В «${t.name}»: ${n}`);
    endSelect();
  }

  function albumChanged(file: FileItem, r: PickResult) {
    const a = r.album;
    if (a) quick.note([file.id], a.id, r.removed);
    say(!a ? 'Ничего не изменилось' : r.removed ? `Убрано из альбома «${a.name}»` : `В альбоме «${a.name}»`);
    if (r.removed && a && inAlbum && album && a.id === album.id) leaveFeed(file.id);
  }

  async function hideSelected() {
    const ids = [...selected];
    try {
      const n = await api.bulk('hide', ids);
      ids.forEach((id) => { library.remove(id); albumFeed.remove(id); });
      endSelect();
      refreshUsage();
      say(n === 1 ? 'Файл скрыт' : `Скрыто файлов: ${n}`, { label: 'Вернуть', run: () => { api.bulk('restore', ids).then(() => { library.loadMore(true); if (album) albumFeed.loadMore(true); refreshUsage(); }).catch(() => say('Не получилось вернуть')); } });
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось скрыть');
    }
  }

  async function saveSelected() {
    if (!album) return;
    const ids = [...selected];
    try {
      const r = await api.saveAlbum(album.id, ids);
      savedToast(r);
      endSelect();
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось сохранить');
    }
  }
  function savedToast(r: { added: number; skipped: number; quota: boolean }) {
    library.loadMore(true);
    refreshUsage();
    if (r.quota) say(`Сохранено: ${r.added}. Остальное не влезло в вашу квоту`);
    else if (r.added === 0) say('Эти фото уже в вашей библиотеке');
    else say(`Сохранено в библиотеку: ${r.added}${r.skipped ? `, уже были: ${r.skipped}` : ''}`);
  }

  async function removeSelectedFromAlbum() {
    if (!album) return;
    const ids = [...selected];
    try {
      const n = await api.albumRemoveFiles(album.id, ids);
      quick.note(ids, null);
      ids.forEach((id) => albumFeed.remove(id));
      say(`Убрано из альбома: ${n}`);
      endSelect();
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось');
    }
  }

  function selectionPicked(r: PickResult) {
    const ids = picker ?? [];
    const a = r.album;
    setPicker(null);
    if (!a) return;
    quick.note(ids, a.id);
    say(`В альбом «${a.name}»: ${r.n}`);
    endSelect();
  }

  const gallery = (feed: typeof library) => (
    <Gallery files={feed.files} loaded={feed.loaded} loading={feed.loading} hasMore={feed.hasMore} error={feed.error} onMore={() => feed.loadMore()} onOpen={(id) => setViewer({ id })} onAdd={() => input.current?.click()}
      quick={quick.target ? { name: quick.target.name, has: quick.has, toggle: (id) => { void quickTile(id); } } : null} chip={quick.saved ? { name: quick.saved.name, on: quick.on } : null} onQuickOn={quick.setOn} onPickQuick={() => setTargetPicker(true)}
      selecting={selecting} selected={selected} onSelecting={(on) => (on ? setSelecting(true) : endSelect())} onToggle={(id) => setSelected((s) => toggled(s, id))} onToggleMany={(ids, on) => setSelected((s) => setMany(s, ids, on))}
      empty={inAlbum ? <p className="mx-auto max-w-md px-4 py-20 text-center text-gray-600 dark:text-gray-400">В альбоме пока нет файлов. Откройте фото в библиотеке и нажмите «В альбом» или выберите сразу много кнопкой «Выбрать».</p> : undefined} />
  );

  async function logout() {
    try { await api.logout(); } catch { /* всё равно уходим на экран входа */ }
    onLogout();
  }

  return (
    <div className="min-h-screen">
      <TopBar user={user} view={view} onView={changeView} usage={usage} onAdd={() => input.current?.click()} onAddFolder={() => folderInput.current?.click()} theme={theme} onToggleTheme={toggleTheme} onLogout={logout} />
      <input ref={input} type="file" multiple accept="image/*,video/*,.heic,.heif" className="hidden" data-testid="file-input" onChange={(e) => { void startUpload(Array.from(e.target.files ?? []).map((file) => ({ file, path: file.name }))); e.target.value = ''; }} />
      <input ref={folderInput} type="file" multiple className="hidden" data-testid="folder-input" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { void startUpload(filesFromInput(e.target.files)); e.target.value = ''; }} />
      <main>
        {view === 'library' && gallery(library)}
        {view === 'albums' && !album && <AlbumsView albums={albums} onOpen={(a) => { setAlbum(a); endSelect(); }} onCreated={(a) => { setAlbums((l) => [...(l ?? []), a]); say(`Альбом «${a.name}» создан`); }} onError={say}
          quickId={quick.target?.id} onQuick={(a) => { quick.set(a ? { id: a.id, name: a.name } : null); say(a ? `Быстрый альбом: «${a.name}». В библиотеке нажимайте «+» на фото` : 'Быстрый альбом выключен'); }} />}
        {view === 'albums' && album && (
          <>
            <AlbumHeader album={album} count={albumFeed.loaded ? albumFeed.files.length : album.count} onBack={() => changeView('albums')} onRenamed={(a) => { setAlbum(a); if (quick.target?.id === a.id) quick.set({ id: a.id, name: a.name }); say('Название изменено'); }} onDeleted={() => { if (quick.target?.id === album.id) quick.set(null); say('Альбом удалён, фото остались'); changeView('albums'); }} onError={say}
              onShare={() => setSharing(true)} onSaved={savedToast} onLeft={() => { say('Альбом убран из вашего списка'); changeView('albums'); }}
              isQuick={quick.target?.id === album.id} onQuick={() => { const on = quick.target?.id !== album.id; quick.set(on ? { id: album.id, name: album.name } : null); say(on ? `Быстрый альбом: «${album.name}». В библиотеке нажимайте «+» на фото` : 'Быстрый альбом выключен'); }} />
            {gallery(albumFeed)}
          </>
        )}
        {view === 'security' && <SecurityView onError={say} />}
        {view === 'similar' && <SimilarView onTrashed={(ids) => { ids.forEach((id) => library.remove(id)); refreshUsage(); say(ids.length === 1 ? 'Файл скрыт' : `Скрыто файлов: ${ids.length}`); }} onError={say} />}
        {view === 'trash' && (
          <TrashView files={trash.files} loaded={trash.loaded} loading={trash.loading} hasMore={trash.hasMore} error={trash.error} onMore={() => trash.loadMore()}
            onRestored={(f) => { trash.remove(f.id); library.add(f); refreshUsage(); say('Файл возвращён в библиотеку'); }}
            onPurged={(id) => { trash.remove(id); refreshUsage(); say('Файл убран, место освобождено'); }}
            onEmptied={(n) => { trash.loadMore(true); refreshUsage(); say(`Убрано файлов: ${n}`); }}
            onRestoredMany={() => { trash.loadMore(true); library.loadMore(true); refreshUsage(); }} onError={say} />
        )}
      </main>
      <AnimatePresence>
        {selecting && (view === 'library' || inAlbum) && (
          <SelectionBar key="selbar" ids={[...selected]} total={active.files.length} zipName={inAlbum && album ? album.name : 'DV Cloud'} inAlbum={inAlbum} shared={foreign} onSave={() => { void saveSelected(); }} onHide={() => { void hideSelected(); }}
            onAlbum={() => setPicker([...selected])} quickName={quick.target?.name} onQuick={() => { void quickSelected(); }} onRemoveFromAlbum={removeSelectedFromAlbum} onAll={() => setSelected(new Set(active.files.map((f) => f.id)))} onCancel={endSelect}
            onTooMany={() => say(`За один раз можно скачать до ${MAX_ZIP_IDS} выбранных файлов. Для большего сложите их в альбом и скачайте альбом целиком.`)} />
        )}
      </AnimatePresence>
      {sharing && album && album.mine && <ShareDialog album={album} onClose={() => setSharing(false)} onError={say} onChanged={(n) => setAlbum((a) => (a ? { ...a, sharedWith: n } : a))} />}
      {picker && <AlbumPicker ids={picker} current={[]} onClose={() => setPicker(null)} onError={say} onDone={selectionPicked} />}
      {targetPicker && <AlbumPicker target ids={[]} current={quick.saved ? [quick.saved] : []} onClose={() => setTargetPicker(false)} onError={say}
        onDone={(r) => { const a = r.album; setTargetPicker(false); quick.set(a); refreshAlbums(); say(a ? `Быстрый альбом: «${a.name}». Нажимайте «+» на фото` : 'Быстрый альбом выключен'); }} />}
      <AnimatePresence>
        {viewer && openIndex >= 0 && (
          <Viewer key="viewer" files={active.files} index={openIndex} onIndex={(i) => setViewer({ id: active.files[i].id })} onClose={() => setViewer(null)} onTrash={foreign ? undefined : (f) => toTrash(f.id)} readOnly={foreign} onAlbumChanged={albumChanged} onError={say}
            quick={quick.target ? { id: quick.target.id, name: quick.target.name, has: quick.has } : null} onQuick={quickFile} />
        )}
      </AnimatePresence>
      <UploadPanel jobs={jobs} onClear={() => queue.clearFinished()} onCancel={() => queue.cancelWaiting()} onRetry={() => queue.retryFailed()} />
      {overQuota && <QuotaDialog est={overQuota.est} count={overQuota.files.length} onFit={() => { const f = overQuota.files; setOverQuota(null); enqueue(f); }} onAsk={() => { void askMore(); }} onCancel={() => setOverQuota(null)} />}
      <Toast toast={toast} onDone={doneToast} />
      <AnimatePresence>
        {dragging && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-violet-600/20 p-6 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-violet-400 bg-gray-950/70 px-12 py-10 text-white">
              <Upload className="size-10" aria-hidden />
              <p className="text-lg font-medium">Отпустите, чтобы загрузить</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
