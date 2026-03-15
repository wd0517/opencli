import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '../../registry.js';

const DEFAULT_URL = 'https://jimeng.jianying.com/ai-tool/home?type=video&workspace=0';
const DEFAULT_IMAGE_REF = '@图片1';
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function parseImageArgs(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [input];
  return values
    .flatMap((value) => {
      if (value == null) return [];
      if (Array.isArray(value)) return parseImageArgs(value);
      const text = String(value).trim();
      if (!text) return [];
      if (text.startsWith('[')) {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) return parseImageArgs(parsed);
        } catch {}
      }
      if (text.includes('\n')) return text.split('\n').map((item) => item.trim()).filter(Boolean);
      if (text.includes('::')) return text.split('::').map((item) => item.trim()).filter(Boolean);
      return [text];
    })
    .map((item) => path.resolve(item));
}

function splitRichReferencePrompt(text: string): Array<{ kind: 'text' | 'mention'; value: string }> {
  const segments: Array<{ kind: 'text' | 'mention'; value: string }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(/@(?:图片|视频|音频)\d+/g)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ kind: 'text', value: text.slice(lastIndex, index) });
    segments.push({ kind: 'mention', value: match[0].slice(1) });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ kind: 'text', value: text.slice(lastIndex) });
  return segments.filter((segment) => segment.value);
}

cli({
  site: 'jimeng',
  name: 'seedance',
  description: '打开即梦视频页并切到 Seedance 2.0 / 全能参考 / 16:9 / 15s',
  domain: 'jimeng.jianying.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'url', default: DEFAULT_URL, help: 'Target Jimeng page URL' },
    { name: 'mode', default: '视频生成', help: 'Generation mode' },
    { name: 'model', default: 'Seedance 2.0', help: 'Video model' },
    { name: 'reference', default: '全能参考', help: 'Reference mode' },
    { name: 'ratio', default: '16:9', help: 'Aspect ratio' },
    { name: 'duration', default: '15s', help: 'Duration' },
    { name: 'image', multiple: true, help: 'Local image path to upload as reference; repeat --image for multiple files' },
    { name: 'prompt', help: 'Optional prompt to fill into the textbox' },
    { name: 'keep_open', type: 'bool', default: false, help: 'Keep the Jimeng tab open after the command exits' },
    { name: 'step_delay', type: 'float', default: 1.2, help: 'Delay between UI actions in seconds' },
  ],
  columns: ['mode', 'model', 'reference', 'ratio', 'duration', 'image_uploaded', 'prompt_filled', 'submitted', 'logged_in', 'url'],
  timeoutSeconds: 120,
  func: async (page, kwargs) => {
    const {
      url = DEFAULT_URL,
      mode = '视频生成',
      model = 'Seedance 2.0',
      reference = '全能参考',
      ratio = '16:9',
      duration = '15s',
      prompt = '',
      image = [],
      step_delay = 1.2,
    } = kwargs;

    const stepDelay = Math.max(Number(step_delay) || 1.2, 0.4);
    const promptText = prompt ? String(prompt).trim() : '';
    const imagePaths = parseImageArgs(image);
    const referenceMode = String(reference).trim();
    for (const imagePath of imagePaths) {
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }
    }
    let stagedImageDir = '';
    let uploadImagePaths = imagePaths;
    if (imagePaths.length > 0) {
      stagedImageDir = fs.mkdtempSync(path.join(process.cwd(), '.opencli-upload-'));
      uploadImagePaths = imagePaths.map((imagePath, index) => {
        const stagedImagePath = path.join(stagedImageDir, `${String(index + 1).padStart(2, '0')}-${path.basename(imagePath)}`);
        fs.copyFileSync(imagePath, stagedImagePath);
        return stagedImagePath;
      });
    }
    const effectivePrompt = imagePaths.length > 0
      ? (/@图片\d+/.test(promptText) ? promptText : `${DEFAULT_IMAGE_REF} ${promptText}`.trim()) || DEFAULT_IMAGE_REF
      : promptText;
    const richReferencePromptPattern = /@(?:图片|视频|音频)\d+/;
    const usesRichReferencePrompt = referenceMode === '全能参考' && richReferencePromptPattern.test(effectivePrompt);
    const richReferenceSegments = usesRichReferencePrompt ? splitRichReferencePrompt(effectivePrompt) : [];
    const richReferenceMentionCount = richReferenceSegments.filter((segment) => segment.kind === 'mention').length;
    const referencedImageIndexes = [...effectivePrompt.matchAll(/@图片(\d+)/g)].map((match) => Number(match[1]));
    const maxReferencedImageIndex = referencedImageIndexes.length > 0 ? Math.max(...referencedImageIndexes) : 0;
    if (usesRichReferencePrompt && imagePaths.length === 0) {
      throw new Error('Prompt references @图片N but no --image was provided');
    }
    if (maxReferencedImageIndex > imagePaths.length) {
      throw new Error(`Prompt references @图片${maxReferencedImageIndex}, but only ${imagePaths.length} image(s) were provided`);
    }
    const normalizedRichPromptValue = effectivePrompt.replace(/@(?=(?:图片|视频|音频)\d+)/g, '').replace(/\s+/g, ' ').trim();
    const emptyResult = () => ({
      mode: '',
      model: '',
      reference: '',
      ratio: '',
      duration: '',
      prompt_filled: false,
      prompt_value: '',
      submitted: false,
      logged_in: false,
      url: String(url),
    });
    const ensureResult = (value: any) => (value && typeof value === 'object' && !Array.isArray(value) ? value : emptyResult());
    const fillRichReferencePrompt = async (text: string) => {
      const segments = splitRichReferencePrompt(text);
      const mentionCount = segments.filter((segment) => segment.kind === 'mention').length;
      if (mentionCount === 0) return { prompt_filled: false, prompt_value: '', mention_count: 0 };
      return page.runCode(`
        async (page) => {
          const payload = ${JSON.stringify({
            segments,
            typeDelayMs: 40,
            waitMs: Math.max(stepDelay * 1000, 400),
          })};
          const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
          const editor = page.locator('.tiptap.ProseMirror').first();
          await editor.click({ force: true });
          await page.waitForTimeout(Math.max(payload.waitMs * 0.4, 180));

          for (const segment of payload.segments) {
            if (segment.kind === 'text') {
              await page.keyboard.type(segment.value, { delay: payload.typeDelayMs });
              continue;
            }

            await page.keyboard.type('@', { delay: payload.typeDelayMs });
            await page.waitForTimeout(Math.max(payload.waitMs * 0.5, 220));
            const option = page.locator('.lv-select-option, [role="option"]').filter({ hasText: segment.value }).first();
            await option.waitFor({ state: 'visible', timeout: Math.max(payload.waitMs * 2, 1200) });
            await option.click({ force: true });
            await page.waitForTimeout(Math.max(payload.waitMs * 0.4, 180));
          }

          await page.waitForTimeout(Math.max(payload.waitMs * 0.75, 300));
          const promptHtml = await editor.innerHTML();
          const promptValue = norm(await editor.textContent());
          const mentionNodes = await editor.locator('.node-reference-mention-tag').count();
          return {
            prompt_filled: promptHtml.includes('node-reference-mention-tag') && mentionNodes > 0,
            prompt_value: promptValue,
            mention_count: mentionNodes,
          };
        }
      `);
    };
    const submitGeneration = async () => page.runCode(`
      async (page) => {
        const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const buttonSelector = '.submit-button-KJTUYS:not(.collapsed-submit-button-o26OIS):not(.collapsed-WjKggt), [class*="submit-button-"]:not(.collapsed-submit-button-o26OIS):not(.collapsed-WjKggt)';
        const body = page.locator('body');
        const beforeText = norm(await body.textContent());
        const submitButton = page.locator(buttonSelector).filter({ visible: true }).last();
        await submitButton.waitFor({ state: 'visible', timeout: 5000 });

        const beforeButtonState = await submitButton.evaluate((el) => ({
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          cls: String(el.className || ''),
          disabled:
            (el instanceof HTMLButtonElement && el.disabled) ||
            el.getAttribute('aria-disabled') === 'true' ||
            el.classList.contains('disabled'),
        }));
        if (beforeButtonState.disabled) {
          return {
            submitted: false,
            submit_state: beforeButtonState.text || beforeButtonState.cls,
            submit_status: 'disabled',
          };
        }

        await submitButton.click({ force: true });
        await page.waitForTimeout(2500);

        const afterText = norm(await body.textContent());
        const signals = [
          /生成中/.test(afterText),
          /队列中/.test(afterText),
          /提交成功/.test(afterText),
          /去查看/.test(afterText) && afterText !== beforeText,
        ];
        const afterButtonState = await page.locator(buttonSelector).filter({ visible: true }).last().evaluate((el) => ({
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          cls: String(el.className || ''),
        })).catch(() => ({ text: '', cls: '' }));

        return {
          submitted: signals.some(Boolean) || afterText !== beforeText,
          submit_state: afterButtonState.text || beforeButtonState.text || '',
          submit_status: /生成中/.test(afterText)
            ? 'generating'
            : /队列中/.test(afterText)
              ? 'queued'
              : /提交成功/.test(afterText)
                ? 'submitted'
                : afterText !== beforeText
                  ? 'changed'
                  : 'idle',
        };
      }
    `);

    const syncState = async (promptValue: string) => page.evaluate(`
      async () => {
        const config = ${JSON.stringify({
          mode: String(mode),
          model: String(model),
          reference: String(reference),
          ratio: String(ratio),
          duration: String(duration),
          prompt: promptValue,
          stepDelayMs: Math.max(stepDelay * 1000, 400),
        })};

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const settle = (factor = 1) => sleep(Math.round(config.stepDelayMs * factor));
        const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };

        const exact = (text, target) => norm(text) === norm(target);
        const includes = (text, target) => norm(text).includes(norm(target));

        const getComboGroups = () => {
          const combos = [...document.querySelectorAll('[role="combobox"]')]
            .filter(visible)
            .sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              if (Math.abs(ra.top - rb.top) > 8) return ra.top - rb.top;
              return ra.left - rb.left;
            });

          const groups = [];
          for (const combo of combos) {
            const top = combo.getBoundingClientRect().top;
            const last = groups[groups.length - 1];
            if (!last || Math.abs(last.top - top) > 8) {
              groups.push({ top, items: [combo] });
            } else {
              last.items.push(combo);
            }
          }
          return groups.filter((group) => group.items.length >= 4);
        };

        const getPrimaryCombos = () => {
          const groups = getComboGroups();
          return (groups[0]?.items ?? groups[groups.length - 1]?.items ?? []).slice(0, 4);
        };

        const openCombo = async (index) => {
          const combo = getPrimaryCombos()[index];
          if (!combo) throw new Error('Combo not found at index ' + index);
          combo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          combo.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          combo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await settle();
          return combo;
        };

        const closeOverlays = () => {
          document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        };

        const chooseOption = async (target, opts = {}) => {
          const allowIncludes = opts.allowIncludes !== false;
          const candidates = [...document.querySelectorAll('.lv-select-option, [role="option"], .home-type-select-option-DHQbP3')]
            .filter(visible);

          let match =
            candidates.find((el) =>
              !el.className.includes('disabled') &&
              exact(el.querySelector('.option-label-pa2yfZ, .label-l6Zq3t, .type-home-select-option-label-ZHxQjz')?.textContent, target),
            ) ??
            candidates.find((el) =>
              !el.className.includes('disabled') &&
              exact(el.textContent, target),
            );

          if (!match && allowIncludes) {
            match =
              candidates.find((el) =>
                !el.className.includes('disabled') &&
                includes(el.querySelector('.option-label-pa2yfZ, .label-l6Zq3t, .type-home-select-option-label-ZHxQjz')?.textContent, target),
              ) ??
              candidates.find((el) =>
                !el.className.includes('disabled') &&
                includes(el.textContent, target),
              );
          }

          if (!match) throw new Error('Option not found: ' + target);

          match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await settle(1.15);
        };

        const setCombo = async (index, target, opts = {}) => {
          const combo = getPrimaryCombos()[index];
          if (!combo) throw new Error('Combo missing at index ' + index);
          if ((opts.exact ? exact(combo.textContent, target) : includes(combo.textContent, target))) {
            return norm(combo.textContent);
          }
          await openCombo(index);
          try {
            await chooseOption(target, { allowIncludes: opts.allowIncludes });
          } catch (err) {
            closeOverlays();
            throw err;
          }
          const updated = norm(getPrimaryCombos()[index]?.textContent || '');
          if (!(opts.exact ? exact(updated, target) : includes(updated, target))) {
            await openCombo(index);
            await chooseOption(target, { allowIncludes: opts.allowIncludes });
          }
          return norm(getPrimaryCombos()[index]?.textContent || '');
        };

        const setRatio = async (target) => {
          const button = [...document.querySelectorAll('button')]
            .filter(visible)
            .find((el) => /\\d+:\\d+/.test(norm(el.textContent)));
          if (!button) throw new Error('Ratio button not found');
          if (includes(button.textContent, target)) return norm(button.textContent);

          button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await settle();

          const ratioOption = [...document.querySelectorAll('.lv-radio label, .lv-radio, .label-l6Zq3t')]
            .filter(visible)
            .find((el) => exact(el.textContent, target) || includes(el.textContent, target));
          const clickable = ratioOption?.closest('label') || ratioOption;
          if (!clickable) {
            closeOverlays();
            throw new Error('Ratio option not found: ' + target);
          }
          clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await settle(1.1);
          closeOverlays();
          return norm(button.textContent);
        };

        const getPromptFields = () => [...document.querySelectorAll('textarea, input, [role="textbox"], [contenteditable="true"]')]
          .filter(visible)
          .filter((el) => {
            const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
            const cls = el.className || '';
            const textContent = el.textContent || '';
            return (
              includes(placeholder, '输入文字') ||
              includes(placeholder, '描述你想创作') ||
              includes(textContent, '上传1-5张参考图或视频') ||
              cls.includes('ProseMirror') ||
              cls.includes('prompt-editor')
            );
          });

        const fillPrompt = async (text) => {
          if (!text) return false;
          const field = getPromptFields()
            .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
          if (!field) return false;

          field.focus();
          if (field instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(field, text);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            field.dispatchEvent(new Event('blur', { bubbles: true }));
            await settle(0.5);
          } else if (field instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(field, text);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            field.dispatchEvent(new Event('blur', { bubbles: true }));
            await settle(0.5);
          } else {
            const editor = field;
            editor.focus();
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
            let inserted = false;
            try {
              inserted = document.execCommand('insertText', false, text);
            } catch {}
            if (!inserted) {
              const textNode = document.createTextNode(text);
              range.insertNode(textNode);
              range.setStartAfter(textNode);
              range.collapse(true);
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
            field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
            field.dispatchEvent(new Event('blur', { bubbles: true }));
            await settle(0.5);
          }

          await settle(0.6);
          const promptValue = getPromptFields()
            .map((field) => ('value' in field ? field.value : field.textContent || ''))
            .map((value) => norm(value))
            .find(Boolean) || '';
          return promptValue === norm(text);
        };

        const readState = () => {
          const combos = getPrimaryCombos().map((el) => norm(el.textContent));
          const button = [...document.querySelectorAll('button')]
            .filter(visible)
            .find((el) => /\\d+:\\d+/.test(norm(el.textContent)));
          return {
            mode: combos[0] || '',
            model: combos[1] || '',
            reference: combos[2] || '',
            duration: combos[3] || '',
            ratio: button ? norm(button.textContent).replace(/720P|1080P/g, '').trim() : '',
          };
        };

        const enforceSelections = async () => {
          await setCombo(0, config.mode, { exact: true });
          await setCombo(1, config.model, { exact: true, allowIncludes: true });
          await setCombo(2, config.reference, { exact: true });
          await setRatio(config.ratio);
          await setCombo(3, config.duration, { exact: true });
          return readState();
        };

        const loggedIn = ![...document.querySelectorAll('*')].some((el) => exact(el.textContent, '登录'));

        await enforceSelections();
        const promptFilled = await fillPrompt(config.prompt);
        if (config.prompt) {
          // Jimeng may auto-recommend and overwrite model/duration shortly after prompt input.
          await settle(1.5);
          await enforceSelections();
          await settle(1.1);
        }
        const finalState = readState();
        const promptValue = getPromptFields()
          .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)
          .map((field) => ('value' in field ? field.value : field.textContent || ''))
          .map((value) => norm(value))
          .find(Boolean) || '';

        return {
          mode: finalState.mode,
          model: finalState.model,
          reference: finalState.reference,
          ratio: finalState.ratio,
          duration: finalState.duration,
          prompt_filled: promptFilled,
          prompt_value: promptValue,
          logged_in: loggedIn,
          url: window.location.href,
        };
      }
    `);

    try {
      await page.goto(String(url));
      await page.wait(Math.max(stepDelay, 3));

      let result = ensureResult(await syncState(''));
      let imageUploaded = false;
      if (uploadImagePaths.length > 0) {
        if (referenceMode === '全能参考') {
          const filesPayload = uploadImagePaths.map((uploadImagePath) => ({
            fileName: path.basename(uploadImagePath),
            mimeType: MIME_BY_EXT[path.extname(uploadImagePath).toLowerCase()] ?? 'application/octet-stream',
            base64: fs.readFileSync(uploadImagePath).toString('base64'),
          }));
          const dropState = await page.evaluate(`
            async () => {
              const payload = ${JSON.stringify(filesPayload)};
              const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
              const visible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
              };
              const targets = [...document.querySelectorAll('.content-oZ2zsI, .prompt-editor-container-A68zI7, .prompt-editor-E3Iuyy, .tiptap.ProseMirror')]
                .filter(visible)
                .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
              const target = targets[0];
              if (!target) return { dropped: false, reason: 'Full-reference editor not found' };

              const dataTransfer = new DataTransfer();
              for (const item of payload) {
                const binary = atob(item.base64);
                const bytes = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
                const file = new File([bytes], item.fileName, { type: item.mimeType });
                dataTransfer.items.add(file);
              }

              const eventInit = { bubbles: true, cancelable: true, dataTransfer };
              target.dispatchEvent(new DragEvent('dragenter', eventInit));
              target.dispatchEvent(new DragEvent('dragover', eventInit));
              target.dispatchEvent(new DragEvent('drop', eventInit));
              await new Promise((resolve) => setTimeout(resolve, 1200));

              const layout = target.closest('.layout-KSckhZ') || target.parentElement || target;
              return {
                dropped: true,
                targetText: norm(target.textContent),
                layoutText: norm(layout?.textContent || ''),
              };
            }
          `);
          if (!dropState?.dropped) {
            throw new Error(dropState?.reason || 'Failed to drop reference image into Jimeng editor');
          }
        } else {
          const pickerState = await page.evaluate(`
            () => {
              const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
              const visible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
              };
              const promptBottom = [...document.querySelectorAll('textarea, input, [role="textbox"], [contenteditable="true"]')]
                .filter(visible)
                .filter((el) => {
                  const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
                  const cls = el.className || '';
                  const textContent = el.textContent || '';
                  return (
                    placeholder.includes('输入文字') ||
                    placeholder.includes('描述你想创作') ||
                    textContent.includes('上传1-5张参考图或视频') ||
                    cls.includes('ProseMirror') ||
                    cls.includes('prompt-editor')
                  );
                })
                .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]?.getBoundingClientRect().top ?? window.innerHeight;

              const inputs = [...document.querySelectorAll('input[type="file"]')]
                .filter((el) => el instanceof HTMLInputElement && /image\\//i.test(el.accept || ''))
                .map((input, index) => {
                  const container = input.parentElement || input;
                  const rect = container.getBoundingClientRect();
                  const label = norm(container.textContent || input.getAttribute('aria-label') || '');
                  return {
                    index,
                    label,
                    top: rect.top,
                    left: rect.left,
                    distanceToPrompt: Math.abs(rect.top - promptBottom),
                  };
                })
                .sort((a, b) => (a.distanceToPrompt - b.distanceToPrompt) || (b.top - a.top) || (a.left - b.left));

              const target = inputs[0];
              if (!target) {
                return { opened: false, reason: 'Reference upload input not found' };
              }

              const input = [...document.querySelectorAll('input[type="file"]')][target.index];
              if (!(input instanceof HTMLInputElement)) {
                return { opened: false, reason: 'Reference upload input missing' };
              }

              try {
                if (typeof input.showPicker === 'function') {
                  input.showPicker();
                  return { opened: true, mode: 'showPicker', target };
                }
                input.click();
                return { opened: true, mode: 'input.click', target };
              } catch (error) {
                return { opened: false, reason: String(error), target };
              }
            }
          `);

          if (!pickerState?.opened) {
            const rawSnapshot = String(await page.snapshot({ raw: true }));
            const referenceRefs = [...rawSnapshot.matchAll(/(?:generic|button)\s+\[ref=(e\d+)\][^\n]*:\s*参考内容/g)].map((match) => match[1]);
            const frameRefs = [...rawSnapshot.matchAll(/(?:generic|button)\s+\[ref=(e\d+)\][^\n]*:\s*(?:首帧|尾帧)/g)].map((match) => match[1]);
            const uploadRef = referenceRefs.at(-1) ?? frameRefs.at(-1) ?? referenceRefs[0] ?? frameRefs[0];
            if (!uploadRef) {
              throw new Error('Reference upload target not found on Jimeng page');
            }
            await page.wait(stepDelay);
            await page.click(uploadRef);
          }

          await page.fileUpload(uploadImagePaths);
          await page.wait(Math.max(stepDelay * 4, 4));
        }

        await page.wait(Math.max(stepDelay * 4, 4));

        const uploadState = await page.evaluate(`
          () => {
            const config = ${JSON.stringify({ reference: String(reference) })};
            const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
            const visible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const issues = [...document.querySelectorAll('[role="alert"], [role="status"], .lv-message, .semi-notice')]
              .map((el) => norm(el.textContent))
              .filter((text) => /(失败|过小|过大|不支持|无法上传|error)/i.test(text));
            const promptFields = [...document.querySelectorAll('textarea, input, [role="textbox"], [contenteditable="true"]')]
              .filter(visible)
              .filter((el) => {
                const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
                const cls = el.className || '';
                const textContent = el.textContent || '';
                return (
                  placeholder.includes('输入文字') ||
                  placeholder.includes('描述你想创作') ||
                  textContent.includes('上传1-5张参考图或视频') ||
                  cls.includes('ProseMirror') ||
                  cls.includes('prompt-editor')
                );
              })
              .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
            const promptBottom = promptFields[0]?.getBoundingClientRect().top ?? window.innerHeight;
            const promptText = promptFields
              .map((el) => norm('value' in el ? el.value : el.textContent || ''))
              .join(' ');

            if (config.reference === '全能参考') {
              const layouts = [...document.querySelectorAll('.layout-KSckhZ')]
                .filter(visible)
                .map((layout) => ({
                  layout,
                  top: layout.getBoundingClientRect().top,
                  distanceToPrompt: Math.abs(layout.getBoundingClientRect().top - promptBottom),
                }))
                .sort((a, b) => (a.distanceToPrompt - b.distanceToPrompt) || (b.top - a.top));
              const targetLayout = layouts[0]?.layout;
              const previewNodes = targetLayout
                ? [...targetLayout.querySelectorAll('.reference-XniveR img, .reference-XniveR video, .reference-XniveR canvas, .reference-group-content-ztz9q2 img, .reference-group-content-ztz9q2 video, .reference-group-content-ztz9q2 canvas')]
                : [];
              const previewCount = previewNodes.filter((node) => {
                if (node instanceof HTMLCanvasElement) return true;
                const src = node.getAttribute('src') || '';
                return /^(blob:|data:)/.test(src);
              }).length;
              return {
                issue: issues[issues.length - 1] || '',
                fileCount: 0,
                fileNames: [],
                targetIds: targetLayout ? [...targetLayout.querySelectorAll('[id*="reference-upload-"]')].map((el) => el.id || '') : [],
                targetTexts: targetLayout ? [norm(targetLayout.textContent || '')] : [],
                hasPreview: previewCount > 0,
                previewCount,
                hasImageRef: /@图片\\d+/.test(promptText),
              };
            }

            const rankedInputs = [...document.querySelectorAll('input[type="file"]')]
              .filter((el) => el instanceof HTMLInputElement && /image\\//i.test(el.accept || ''))
              .map((input, index) => {
                const container = input.parentElement || input;
                const rect = container.getBoundingClientRect();
                return {
                  index,
                  input,
                  container,
                  distanceToPrompt: Math.abs(rect.top - promptBottom),
                  top: rect.top,
                  left: rect.left,
                };
              })
              .sort((a, b) => (a.distanceToPrompt - b.distanceToPrompt) || (b.top - a.top) || (a.left - b.left));
            const targetEntries = rankedInputs.slice(0, 2);
            const targetContainers = targetEntries
              .map((entry) => entry.container)
              .filter((container) => container instanceof HTMLElement);
            const targetFileCount = targetEntries
              .reduce((sum, entry) => sum + (((entry.input instanceof HTMLInputElement ? entry.input.files?.length : 0) || 0)), 0);
            const targetFileNames = targetEntries
              .flatMap((entry) => (entry.input instanceof HTMLInputElement ? [...(entry.input.files || [])].map((file) => file.name) : []));
            const hasPreview = targetContainers.some((container) => {
              const mediaNode = [...container.querySelectorAll('img, video, canvas')]
                .find((el) => {
                  const src = ('src' in el ? el.getAttribute('src') || '' : '') || '';
                  if (src && /^(blob:|data:)/.test(src)) return true;
                  if (el instanceof HTMLCanvasElement) return true;
                  return false;
                });
              if (mediaNode) return true;
              if (getComputedStyle(container).backgroundImage !== 'none') return true;
              return [...container.querySelectorAll('*')]
                .some((el) => getComputedStyle(el).backgroundImage !== 'none');
            });
            return {
              issue: issues[issues.length - 1] || '',
              fileCount: targetFileCount,
              fileNames: targetFileNames,
              targetIds: targetContainers.map((container) => container.id || ''),
              targetTexts: targetContainers.map((container) => norm(container.textContent || '')),
              hasPreview,
              previewCount: hasPreview ? Math.max(targetFileCount, 1) : 0,
              hasImageRef: /@图片\\d+/.test(promptText),
            };
          }
        `);
        if (uploadState?.issue) {
          throw new Error(`Jimeng rejected reference image: ${uploadState.issue}`);
        }
        if (!uploadState?.hasPreview) {
          const details = [
            uploadState?.fileCount ? `files=${uploadState.fileCount}` : '',
            uploadState?.previewCount ? `previews=${uploadState.previewCount}` : '',
            uploadState?.targetIds?.length ? `targets=${uploadState.targetIds.join(',')}` : '',
            uploadState?.targetTexts?.length ? `texts=${uploadState.targetTexts.join(' | ')}` : '',
          ]
            .filter(Boolean)
            .join(' ');
          throw new Error(`Jimeng did not accept the reference image upload${details ? ` (${details})` : ''}`);
        }
        if ((uploadState?.previewCount || uploadState?.fileCount || 0) < uploadImagePaths.length) {
          throw new Error(`Jimeng only accepted ${uploadState?.previewCount || uploadState?.fileCount || 0}/${uploadImagePaths.length} reference images`);
        }
        imageUploaded = true;
      }

      result = ensureResult(await syncState(usesRichReferencePrompt ? '' : effectivePrompt));
      if (usesRichReferencePrompt && effectivePrompt) {
        const richPromptState = ensureResult(await syncState(''));
        const insertedPrompt = await fillRichReferencePrompt(effectivePrompt);
        const stabilized = ensureResult(await syncState(''));
        result = {
          ...result,
          ...richPromptState,
          ...stabilized,
          prompt_value: insertedPrompt?.prompt_value ?? stabilized.prompt_value ?? result.prompt_value,
          prompt_filled:
            !!insertedPrompt?.prompt_filled &&
            (insertedPrompt?.mention_count || 0) >= richReferenceMentionCount &&
            !!(insertedPrompt?.prompt_value || '').includes(normalizedRichPromptValue),
        };
        if (!result.prompt_filled) {
          throw new Error('Failed to insert Jimeng reference token into the prompt');
        }
      }
      result.image_uploaded = imageUploaded;

      if (!usesRichReferencePrompt && effectivePrompt && (!result?.prompt_filled || !result?.prompt_value)) {
        try {
          const rawSnapshot = String(await page.snapshot({ raw: true }));
          const textboxRefs = [...rawSnapshot.matchAll(/textbox(?:\s+"[^"]*")?\s+\[ref=(e\d+)\]/g)].map((match) => match[1]);
          const targetRef = textboxRefs[textboxRefs.length - 1];
          if (targetRef) {
            await page.wait(stepDelay);
            await page.click(targetRef);
            await page.wait(stepDelay);
            await page.typeText(targetRef, effectivePrompt);
            await page.wait(Math.max(stepDelay * 0.75, 0.5));
            const promptState = await page.evaluate(`
              () => {
                const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
                const visible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                };
                const candidates = [...document.querySelectorAll('textarea, input, [role="textbox"], [contenteditable="true"]')]
                  .filter(visible)
                  .filter((el) => {
                    const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
                    const cls = el.className || '';
                    const textContent = el.textContent || '';
                    return (
                      placeholder.includes('输入文字') ||
                      placeholder.includes('描述你想创作') ||
                      textContent.includes('上传1-5张参考图或视频') ||
                      cls.includes('ProseMirror') ||
                      cls.includes('prompt-editor')
                    );
                  })
                  .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
                const value = candidates
                  .map((el) => ('value' in el ? el.value : el.textContent || ''))
                  .map((v) => norm(v))
                  .find(Boolean) || '';
                return { value };
              }
            `);
            const stabilized = ensureResult(await syncState(''));
            result = {
              ...result,
              ...stabilized,
              prompt_value: promptState?.value ?? result.prompt_value,
              prompt_filled: !!promptState?.value && promptState.value.includes(effectivePrompt),
              image_uploaded: imageUploaded,
            };
          }
        } catch {}
      }

      const submitState = await submitGeneration();
      result = {
        ...result,
        submitted: !!submitState?.submitted,
        submit_state: submitState?.submit_state || '',
        submit_status: submitState?.submit_status || '',
      };
      if (!result.submitted) {
        throw new Error(`Failed to submit Jimeng generation${result.submit_status ? ` (${result.submit_status})` : ''}`);
      }

      return result;
    } finally {
      if (stagedImageDir) {
        fs.rmSync(stagedImageDir, { recursive: true, force: true });
      }
    }
  },
});
