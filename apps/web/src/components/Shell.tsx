import { AnimatePresence, motion } from 'framer-motion';
import { Film, Images, Smartphone, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, sendFile } from '../api';
import { useFeed } from '../lib/useFeed';
import { useQuickAlbum } from '../lib/quick';
import { UploadQueue, type UploadJob } from '../lib/uploader';
import { claimFile } from '../lib/claim';
import { filesFromDrop, filesFromInput, uploadable, type PickedFile } from '../lib/folders';
import { countFiles } from '../lib/format';
import { useTheme } from '../lib/theme';
import type { Month } from '../lib/timeline';
import { MAX_ZIP_IDS, setMany, toggled } from '../lib/albums';
import type { Album, AlbumKind, AlbumRef, Estimate, FileItem, PeopleGroup, PeopleList, SearchStatus, Usage, User } from '../types';
import { useSearch } from '../lib/useSearch';
import { PeopleView, PersonHeader } from './PeopleView';
import { SearchView } from './SearchView';
import { QuotaDialog } from './QuotaDialog';
import { AlbumPicker, type PickResult } from './AlbumPicker';
import { AlbumHeader, AlbumsView } from './AlbumsView';
import { AlbumStrip } from './AlbumStrip';
import { Gallery } from './Gallery';
import { YandexView } from './YandexView';
import { SecurityView } from './SecurityView';
import { SelectionBar } from './SelectionBar';
import { ShareDialog } from './ShareDialog';
import { Toast, type ToastData } from './Toast';
import { TopBar, type View } from './TopBar';
import { SimilarView } from './SimilarView';
import { TrashView } from './TrashView';
import { UploadPanel } from './UploadPanel';
import { Aurora, HelpSheet } from './ui';
import { helpKeyFor } from '../lib/help';
import { Viewer } from './Viewer';
import { RemoveFromAlbumDialog } from './RemoveFromAlbumDialog';

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
  const [albumFilter, setAlbumFilter] = useState<AlbumKind | 'all' | 'shared' | 'archive'>('all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delAsk, setDelAsk] = useState<string[] | null>(null); // Del в альбоме: что убираем (окно «из этого / из всех альбомов»)
  const [picker, setPicker] = useState<string[] | null>(null); // что переносим в альбом из режима выбора
  const [sharing, setSharing] = useState(false); // окно «Поделиться альбомом»
  const [targetPicker, setTargetPicker] = useState(false); // окно выбора быстрого альбома

  const library = useFeed(false, undefined, 'library'); // фото и видео без скриншотов
  const photos = useFeed(false, undefined, 'photos'); // картинки без скриншотов
  const videos = useFeed(false, undefined, 'videos');
  const shots = useFeed(false, undefined, 'screenshots');
  const trash = useFeed(true);
  const albumFeed = useFeed(false, album?.id);
  const [peopleList, setPeopleList] = useState<PeopleList | null>(null); // люди и питомцы (см. docs/PEOPLE.md)
  const [showHiddenPeople, setShowHiddenPeople] = useState(false);
  const [coverPick, setCoverPick] = useState(false); // на странице человека: следующее нажатие на фото выбирает обложку
  const [person, setPerson] = useState<PeopleGroup | null>(null); // открытая страница человека (внутри вкладки «Люди»)
  const personFeed = useFeed(false, undefined, undefined, person?.id);
  const search = useSearch();
  const [searchStatus, setSearchStatus] = useState<SearchStatus | null>(null);
  const inPerson = view === 'people' && person !== null;
  const inAlbum = view === 'albums' && album !== null;
  const foreign = inAlbum && album !== null && !album.mine; // чужой общий альбом: только смотреть, сохранять, скачивать
  const active = inAlbum ? albumFeed : inPerson ? personFeed : view === 'search' ? search : view === 'photos' ? photos : view === 'videos' ? videos : view === 'screenshots' ? shots : library; // из какой ленты листает просмотрщик

  const reloadPeople = useCallback(() => { api.peopleGroups(true).then(setPeopleList).catch(() => {}); }, []); // скрытые приходят тоже: прячет их сам список
  const [yandexOn, setYandexOn] = useState(false);
  useEffect(() => { api.yandexStatus().then((y) => setYandexOn(y.enabled)).catch(() => {}); }, []);
  const peopleOn = !!peopleList && (peopleList.enabled.faces || peopleList.enabled.pets);
  const named = useMemo(() => (peopleList?.people ?? []).filter((p) => p.name && !p.hidden), [peopleList]);
  // Страница человека следует за списком: переименование, слияние, роспуск.
  useEffect(() => {
    if (!person || !peopleList) return;
    const now = peopleList.people.find((p) => p.id === person.id);
    if (!now) setPerson(null);
    else if (now.name !== person.name || now.hidden !== person.hidden || now.cover !== person.cover) setPerson(now);
  }, [peopleList, person]);
  const refreshUsage = useCallback(() => { api.usage().then(setUsage).catch(() => {}); }, []);
  const say = useCallback((text: string, action?: ToastData['action']) => setToast({ id: ++toastId.current, text, action }), []);
  const doneToast = useCallback(() => setToast(null), []);
  const quick = useQuickAlbum(say);
  const [helpOpen, setHelpOpen] = useState(false);

  // Оглавление для полосы времени: только в разделах библиотеки; обновляется при смене раздела и когда меняется число файлов.
  // В альбоме и у человека полоса тоже есть: оглавление строится по их файлам. Ключ включает номер, чтобы при смене альбома оглавление перечитывалось.
  const railKind = view === 'photos' ? 'photos' : view === 'videos' ? 'videos' : view === 'screenshots' ? 'screenshots' : view === 'library' ? 'all' : inAlbum ? `album:${album!.id}` : inPerson ? `person:${person!.id}` : null;
  const [tl, setTl] = useState<{ k: string; months: Month[] } | null>(null);
  useEffect(() => {
    if (!railKind) return;
    let stop = false;
    const load = railKind.startsWith('album:') ? api.albumTimeline(railKind.slice(6)) : railKind.startsWith('person:') ? api.timeline(undefined, railKind.slice(7)) : api.timeline(railKind === 'all' ? 'library' : (railKind as 'photos' | 'videos' | 'screenshots'));
    load.then((r) => { if (!stop) setTl({ k: railKind, months: r.months }); }).catch(() => {});
    return () => { stop = true; };
  }, [railKind, usage?.count]);

  const addLib = library.add;
  const queue = useMemo(
    () => new UploadQueue<File & { path?: string }>(sendFile, setJobs, (f, dup) => { if (!dup) addLib(f); refreshUsage(); }, 3, claimFile),
    [addLib, refreshUsage],
  );

  useEffect(() => { library.loadMore(true); refreshUsage(); api.searchStatus().then(setSearchStatus).catch(() => {}); reloadPeople(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { if (view === 'search') { api.searchStatus().then(setSearchStatus).catch(() => {}); reloadPeople(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view]);
  // Права на группу (имя, объединение) могли измениться после действия: обновляем открытого человека из свежего списка.
  useEffect(() => {
    if (!person) return;
    const p = peopleList?.people.find((x) => x.id === person.id);
    if (p && (p.canName !== person.canName || p.canMerge !== person.canMerge || p.shared !== person.shared || p.name !== person.name)) setPerson(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peopleList]);
  useEffect(() => { leftPerson.current.clear(); if (person) personFeed.loadMore(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [person?.id]);
  useEffect(() => {
    // Разделы подгружаются заново при входе: за это время файлы могли добавиться или уйти в корзину.
    if (view === 'photos') void photos.jump(null);
    if (view === 'videos') void videos.jump(null);
    if (view === 'screenshots') void shots.jump(null);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [view]);
  useEffect(() => { if (view === 'trash') trash.loadMore(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view]);
  const refreshAlbums = useCallback(() => { api.albums().then(setAlbums).catch(() => {}); }, []);
  useEffect(() => { if ((view === 'albums' && !album) || view === 'photos' || view === 'videos' || view === 'screenshots') refreshAlbums(); }, [view, album, refreshAlbums]);
  useEffect(() => { if (album) albumFeed.loadMore(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [album?.id]);

  const endSelect = useCallback(() => { setSelecting(false); setSelected(new Set()); }, []);
  // Фото, убранные из группы человека прямо в просмотре: просмотр и лента не трогаются, а когда просмотр закрыт, фото тихо уходят из ленты.
  const leftPerson = useRef(new Set<string>());
  const closeViewer = useCallback(() => {
    setViewer(null);
    const ids = [...leftPerson.current];
    leftPerson.current.clear();
    if (ids.length) ids.forEach((id) => personFeed.remove(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function changeView(v: View) {
    setView(v);
    setAlbum(null);
    setPerson(null);
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
      say(e instanceof Error ? e.message : 'Не получилось убрать в корзину');
      return;
    }
    // Соседний файл показываем вместо удалённого; если соседей нет, просмотрщик закроется сам.
    leaveFeed(id);
    [library, photos, videos, shots, search, personFeed].forEach((f) => f.remove(id)); // файл мог лежать в нескольких лентах сразу
    say('Файл в корзине', {
      label: 'Восстановить',
      run: () => { api.restore(id).then((r) => { library.add(r.file); refreshUsage(); }).catch(() => say('Не получилось восстановить файл')); },
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
    say(a && r.rejected ? `Не подошло по типу альбома «${a.name}»` : !a ? 'Ничего не изменилось' : r.removed ? `Убрано из альбома «${a.name}»` : `В альбоме «${a.name}»`);
    if (r.removed && a && inAlbum && album && a.id === album.id) leaveFeed(file.id);
  }

  async function hideSelected() {
    const ids = [...selected];
    try {
      const n = await api.bulk('hide', ids);
      ids.forEach((id) => { library.remove(id); photos.remove(id); videos.remove(id); shots.remove(id); albumFeed.remove(id); personFeed.remove(id); search.remove(id); });
      endSelect();
      refreshUsage();
      say(n === 1 ? 'Файл в корзине' : `В корзине файлов: ${n}`, { label: 'Восстановить', run: () => { api.bulk('restore', ids).then(() => { library.loadMore(true); if (album) albumFeed.loadMore(true); refreshUsage(); }).catch(() => say('Не получилось восстановить')); } });
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось убрать в корзину');
    }
  }

  // Del в альбоме: окно «только из этого альбома / из всех». Корзина не затрагивается.
  async function removeFromAlbumIds(ids: string[], everywhere: boolean) {
    if (!album) return;
    setDelAsk(null);
    try {
      const n = everywhere ? await api.removeEverywhere(ids) : await api.albumRemoveFiles(album.id, ids);
      quick.note(ids, null);
      ids.forEach((id) => { if (viewer && viewer.id === id) leaveFeed(id); else albumFeed.remove(id); });
      say(everywhere ? 'Убрано из всех альбомов, файлы остались в библиотеке' : `Убрано из альбома «${album.name}»`);
      void n;
      if (ids.length > 1) endSelect();
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось');
    }
  }

  useEffect(() => {
    if (!inAlbum || foreign || !selecting || selected.size === 0 || delAsk || viewer || picker) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Delete' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setDelAsk([...selected]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inAlbum, foreign, selecting, selected, delAsk, viewer, picker]);

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

  // Ручная смена «фото» / «скриншот». Видео не меняются. Лента, где снимок теперь лишний, сразу его убирает.
  async function changeKind(ids: string[], kind: 'screenshot' | 'photo'): Promise<void> {
    const imgs = new Set(active.files.filter((f) => ids.includes(f.id) && f.mime.startsWith('image/')).map((f) => f.id));
    if (imgs.size === 0) { say('Видео не меняют вид: это только для картинок'); return; }
    try {
      await api.setKind(kind, [...imgs]);
      const leaves = (view === 'photos' || view === 'library') ? kind === 'screenshot' : view === 'screenshots' ? kind === 'photo' : false;
      // Если снимок открыт в просмотрщике, показываем соседний (как после «В корзину»), а не закрываем просмотр.
      if (leaves) imgs.forEach((id) => (viewer && viewer.id === id ? leaveFeed(id) : active.remove(id))); else active.patch(imgs, { screenshot: kind === 'screenshot' });
      const back = kind === 'screenshot' ? 'photo' : 'screenshot';
      say(kind === 'screenshot' ? `В скриншотах: ${imgs.size}` : `Теперь это фото: ${imgs.size}`, leaves ? {
        label: 'Вернуть',
        run: () => { api.setKind(back, [...imgs]).then(() => { [library, photos, shots].forEach((f) => { if (f.loaded) void f.loadMore(true); }); }).catch(() => say('Не получилось вернуть')); },
      } : undefined);
      endSelect();
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось');
    }
  }

  async function removeSelectedFromPerson() {
    if (!person) return;
    const ids = [...selected];
    try {
      const n = (await api.removeManyFromPerson(person.id, ids)).removed;
      ids.forEach((id) => personFeed.remove(id));
      reloadPeople();
      say(n > 0 ? `Убрано из группы: ${n}. В эту группу они больше не попадут` : 'В этой группе этих фото уже нет');
      endSelect();
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось');
    }
  }

  function albumCreated(a: Album) {
    setAlbums((l) => [...(l ?? []), a]);
    say(`Альбом «${a.name}» создан`);
    refreshAlbums();
  }

  async function toggleFavorite(a: Album) {
    try {
      const n = await api.albumFavorite(a.id, !a.favorite);
      setAlbums((l) => (l ?? []).map((x) => (x.id === n.id ? n : x)));
      refreshAlbums(); // порядок задаёт сервер
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось');
    }
  }

  // Какого вида выбранные файлы (если все одного вида): по этому в окне выбора первыми идут подходящие альбомы.
  function pickKind(ids: string[]): Exclude<AlbumKind, 'any'> | undefined {
    const fs = active.files.filter((f) => ids.includes(f.id));
    if (fs.length === 0) return undefined;
    const k = (f: FileItem): Exclude<AlbumKind, 'any'> => (f.mime.startsWith('video/') ? 'videos' : f.screenshot ? 'screenshots' : 'photos');
    const first = k(fs[0]);
    return fs.every((f) => k(f) === first) ? first : undefined;
  }

  function selectionPicked(r: PickResult) {
    const ids = picker ?? [];
    const a = r.album;
    setPicker(null);
    if (!a) return;
    quick.note(ids, a.id);
    say(r.rejected ? `В альбом «${a.name}»: ${r.n}. Не подошло по типу альбома: ${r.rejected} из ${ids.length}` : `В альбом «${a.name}»: ${r.n}`);
    endSelect();
  }

  const emptyNote = (icon: ReactNode, title: string, text: string) => (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
      <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-paper-200 text-gray-500 dark:bg-gray-900">{icon}</span>
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{title}</h2>
      <p className="mt-2 text-gray-600 dark:text-gray-400">{text}</p>
    </div>
  );

  useEffect(() => { setCoverPick(false); }, [person?.id]);
  function chooseCover(fileId: string) {
    if (!person) return;
    api.setPersonCover(person.id, fileId).then(() => { setCoverPick(false); reloadPeople(); say('Обложка обновлена'); }).catch((e) => say(e instanceof Error ? e.message : 'Не получилось поменять обложку'));
  }
  function resetCover() {
    if (!person) return;
    api.setPersonCover(person.id, null).then(() => { setCoverPick(false); reloadPeople(); say('Обложка снова выбирается автоматически'); }).catch((e) => say(e instanceof Error ? e.message : 'Не получилось'));
  }

  const gallery = (feed: typeof library, empty?: ReactNode, timeline = false) => (
    <Gallery rail={timeline && tl && tl.k === railKind ? { months: tl.months, at: feed.at, hasNewer: feed.hasNewer, onJump: feed.jump, onNewer: feed.loadNewer } : null} files={feed.files} loaded={feed.loaded} loading={feed.loading} hasMore={feed.hasMore} error={feed.error} onMore={() => feed.loadMore()} onOpen={(id) => (coverPick && person ? chooseCover(id) : setViewer({ id }))} onAdd={() => input.current?.click()}
      quick={quick.target ? { name: quick.target.name, has: quick.has, toggle: (id) => { void quickTile(id); } } : null} chip={quick.saved ? { name: quick.saved.name, on: quick.on } : null} onQuickOn={quick.setOn} onPickQuick={() => setTargetPicker(true)}
      selecting={selecting} selected={selected} onSelecting={(on) => (on ? setSelecting(true) : endSelect())} onToggle={(id) => setSelected((s) => toggled(s, id))} onToggleMany={(ids, on) => setSelected((s) => setMany(s, ids, on))}
      empty={empty ?? (inAlbum ? <p className="mx-auto max-w-md px-4 py-20 text-center text-gray-600 dark:text-gray-400">В альбоме пока нет файлов. Откройте фото в библиотеке и нажмите «В альбом» или выберите сразу много кнопкой «Выбрать».</p> : undefined)} />
  );

  async function logout() {
    try { await api.logout(); } catch { /* всё равно уходим на экран входа */ }
    onLogout();
  }

  return (
    <div className="min-h-screen">
      <Aurora section={view} />
      <TopBar onHelp={() => setHelpOpen(true)} hideDock={selecting} user={user} view={view} onView={changeView} usage={usage} onAdd={() => input.current?.click()} onAddFolder={() => folderInput.current?.click()} searchOn={!!searchStatus?.enabled || named.length > 0} peopleOn={peopleOn} yandexOn={yandexOn} theme={theme} onToggleTheme={toggleTheme} onLogout={logout} />
      <input ref={input} type="file" multiple accept="image/*,video/*,.heic,.heif" className="hidden" data-testid="file-input" onChange={(e) => { void startUpload(Array.from(e.target.files ?? []).map((file) => ({ file, path: file.name }))); e.target.value = ''; }} />
      <input ref={folderInput} type="file" multiple className="hidden" data-testid="folder-input" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { void startUpload(filesFromInput(e.target.files)); e.target.value = ''; }} />
      <motion.main key={`${view}:${album?.id ?? ''}:${person?.id ?? ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }} className="pb-16 sm:pb-0">
        {view === 'library' && gallery(library, undefined, true)}
        {view === 'photos' && <><AlbumStrip kind="photos" albums={albums} onOpen={(a) => { setView('albums'); setAlbum(a); endSelect(); }} onAll={() => { setAlbumFilter('photos'); changeView('albums'); }} onCreated={albumCreated} onError={say} />{gallery(photos, emptyNote(<Images className="size-8" aria-hidden />, 'Фото пока нет', 'Здесь собраны фотографии без скриншотов. Видео и скриншоты лежат на своих вкладках, а всё вместе в «Библиотеке».'), true)}</>}
        {view === 'videos' && <><AlbumStrip kind="videos" albums={albums} onOpen={(a) => { setView('albums'); setAlbum(a); endSelect(); }} onAll={() => { setAlbumFilter('videos'); changeView('albums'); }} onCreated={albumCreated} onError={say} />{gallery(videos, emptyNote(<Film className="size-8" aria-hidden />, 'Видео пока нет', 'Здесь будут все ваши видео. Добавьте их кнопкой «Добавить» или перетащите в окно браузера.'), true)}</>}
        {view === 'screenshots' && <><AlbumStrip kind="screenshots" albums={albums} onOpen={(a) => { setView('albums'); setAlbum(a); endSelect(); }} onAll={() => { setAlbumFilter('screenshots'); changeView('albums'); }} onCreated={albumCreated} onError={say} />{gallery(shots, (
          <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
            <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-paper-200 text-gray-500 dark:bg-gray-900"><Smartphone className="size-8" aria-hidden /></span>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Скриншотов пока нет</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">Облако само находит снимки экрана среди ваших файлов. Для уже загруженных это занимает время: поиск идёт в фоне, когда нет загрузок. Новые скриншоты появятся здесь сразу после обработки.</p>
          </div>
        ), true)}</>}
        {view === 'albums' && !album && <AlbumsView albums={albums} filter={albumFilter} onFilter={setAlbumFilter} onFavorite={toggleFavorite} onOpen={(a) => { setAlbum(a); endSelect(); }} onCreated={albumCreated} onError={say}
          quickId={quick.target?.id} onQuick={(a) => { quick.set(a ? { id: a.id, name: a.name } : null); say(a ? `Быстрый альбом: «${a.name}». В библиотеке нажимайте «+» на фото` : 'Быстрый альбом выключен'); }} />}
        {view === 'albums' && album && (
          <>
            <AlbumHeader album={album} count={albumFeed.loaded && !albumFeed.hasMore ? albumFeed.files.length : album.count} onBack={() => changeView('albums')} onRenamed={(a) => { setAlbum(a); if (quick.target?.id === a.id) quick.set({ id: a.id, name: a.name }); say('Название изменено'); }} onDeleted={() => { if (quick.target?.id === album.id) quick.set(null); say('Альбом удалён, фото остались'); changeView('albums'); }} onError={say}
              onShare={() => setSharing(true)} onLeft={() => { say('Альбом убран из вашего списка'); changeView('albums'); }}
              isQuick={quick.target?.id === album.id} onQuick={() => { const on = quick.target?.id !== album.id; quick.set(on ? { id: album.id, name: album.name } : null); say(on ? `Быстрый альбом: «${album.name}». В библиотеке нажимайте «+» на фото` : 'Быстрый альбом выключен'); }} />
            {gallery(albumFeed, undefined, true)}
          </>
        )}
        {view === 'people' && !person && <PeopleView list={peopleList} showHidden={showHiddenPeople} onShowHidden={setShowHiddenPeople} onOpen={(p) => { setPerson(p); endSelect(); }} onReload={() => reloadPeople()} />}
        {view === 'people' && person && (
          <>
            <PersonHeader coverPick={coverPick} onCoverPick={setCoverPick} onResetCover={resetCover} person={person} others={(peopleList?.people ?? []).filter((p) => p.kind === person.kind && p.id !== person.id && !p.hidden && p.canMerge)} count={personFeed.loaded && !personFeed.hasMore ? personFeed.files.length : null}
              onBack={() => { setPerson(null); setCoverPick(false); endSelect(); reloadPeople(); }} onChanged={(p) => { setPerson(p); reloadPeople(); }} onGone={(t) => { setPerson(null); reloadPeople(); say(t); }} onError={say} />
            {gallery(personFeed, <p className="mx-auto max-w-md px-4 py-20 text-center text-gray-600 dark:text-gray-400">Файлов с этим человеком пока нет.</p>, true)}
          </>
        )}
        {view === 'search' && <SearchView search={search} status={searchStatus} named={named} onOpen={(id) => setViewer({ id })} onPerson={(id) => { const p = peopleList?.people.find((x) => x.id === id); if (p) { setView('people'); setAlbum(null); setPerson(p); endSelect(); } }} />}
        {view === 'yandex' && <YandexView onError={say} />}
        {view === 'security' && <SecurityView onError={say} />}
        {view === 'similar' && <SimilarView onTrashed={(ids) => { ids.forEach((id) => library.remove(id)); refreshUsage(); say(ids.length === 1 ? 'Файл в корзине' : `В корзине файлов: ${ids.length}`); }} onError={say} />}
        {view === 'trash' && (
          <TrashView files={trash.files} loaded={trash.loaded} loading={trash.loading} hasMore={trash.hasMore} error={trash.error} onMore={() => trash.loadMore()}
            onRestored={(f) => { trash.remove(f.id); library.add(f); refreshUsage(); say('Файл возвращён в библиотеку'); }}
            onPurged={(id) => { trash.remove(id); refreshUsage(); say('Файл убран, место освобождено'); }}
            onEmptied={(n) => { trash.loadMore(true); refreshUsage(); say(`Убрано файлов: ${n}`); }}
            onRestoredMany={() => { trash.loadMore(true); library.loadMore(true); refreshUsage(); }} onError={say} />
        )}
      </motion.main>
      <HelpSheet topic={helpKeyFor(view)} open={helpOpen} onClose={() => setHelpOpen(false)} />
      <AnimatePresence>
        {selecting && (view === 'library' || view === 'photos' || view === 'videos' || view === 'screenshots' || inAlbum || inPerson) && (
          <SelectionBar key="selbar" ids={[...selected]} total={active.files.length} zipName={inAlbum && album ? album.name : 'DV Cloud'} inAlbum={inAlbum} shared={foreign} onHide={() => { void hideSelected(); }}
            onAlbum={() => setPicker([...selected])} quickName={quick.target?.name} onQuick={() => { void quickSelected(); }} onRemoveFromAlbum={removeSelectedFromAlbum} inPerson={inPerson} onRemoveFromPerson={() => { void removeSelectedFromPerson(); }} kinds={view === 'screenshots' ? ['photo'] : view === 'photos' || view === 'library' ? ['screenshot'] : ['screenshot', 'photo']} onKind={(k) => { void changeKind([...selected], k); }} onAll={() => setSelected(new Set(active.files.map((f) => f.id)))} onCancel={endSelect}
            onTooMany={() => say(`За один раз можно скачать до ${MAX_ZIP_IDS} выбранных файлов. Для большего сложите их в альбом и скачайте альбом целиком.`)} />
        )}
      </AnimatePresence>
      {sharing && album && album.mine && <ShareDialog album={album} onClose={() => setSharing(false)} onError={say} onChanged={(n) => setAlbum((a) => (a ? { ...a, sharedWith: n } : a))} />}
      {delAsk && album && <RemoveFromAlbumDialog albumId={album.id} albumName={album.name} ids={delAsk} onThis={() => { void removeFromAlbumIds(delAsk, false); }} onAll={() => { void removeFromAlbumIds(delAsk, true); }} onCancel={() => setDelAsk(null)} />}
      {picker && <AlbumPicker ids={picker} fitKind={pickKind(picker)} current={[]} onClose={() => setPicker(null)} onError={say} onDone={selectionPicked} />}
      {targetPicker && <AlbumPicker target ids={[]} current={quick.saved ? [quick.saved] : []} onClose={() => setTargetPicker(false)} onError={say}
        onDone={(r) => { const a = r.album; setTargetPicker(false); quick.set(a); refreshAlbums(); say(a ? `Быстрый альбом: «${a.name}». Нажимайте «+» на фото` : 'Быстрый альбом выключен'); }} />}
      <AnimatePresence>
        {viewer && openIndex >= 0 && (
          <Viewer key="viewer" files={active.files} index={openIndex} onIndex={(i) => setViewer({ id: active.files[i].id })} onClose={closeViewer} onTrash={foreign ? undefined : inAlbum ? (f) => setDelAsk([f.id]) : (f) => toTrash(f.id)} fromAlbum={inAlbum} onKind={foreign ? undefined : (f, k) => { void changeKind([f.id], k); }} readOnly={foreign} onAlbumChanged={albumChanged} onError={say}
            quick={quick.target ? { id: quick.target.id, name: quick.target.name, has: quick.has } : null} onQuick={quickFile}
            people={peopleOn ? { groups: (peopleList?.people ?? []).filter((p) => !p.hidden), onChanged: reloadPeople, onLeft: (fid) => { leftPerson.current.add(fid); }, onNote: say } : null} />
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
