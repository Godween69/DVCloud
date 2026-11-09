-- DV Cloud 0.10.0: поддержка HEIC. Раньше такие фото не разбирались, и по ним записывались неудачи:
-- «нет миниатюры» для поиска по смыслу и «картинка не читается» для лиц и питомцев.
-- Убираем эти записи, и фоновые задачи сами попробуют ещё раз, уже с декодером HEIC. Успешные записи не трогаются.
DELETE FROM embeddings e USING blobs b
 WHERE e.blob_id = b.id AND e.status = 'failed' AND b.mime IN ('image/heic', 'image/heif');
DELETE FROM detection_scans d USING blobs b
 WHERE d.blob_id = b.id AND d.status = 'failed' AND b.mime IN ('image/heic', 'image/heif');
