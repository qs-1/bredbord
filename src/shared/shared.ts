// The page for a shared link, /c/<code>: the circuit's picture, title, maker, description and parts,
// and a button that opens it on the desk as a copy (the desk fetches it again by its code, so nothing
// large goes through the address).

import './shared.css';
import { circuitByLink, codeFromPath } from '../community/links';
import { partName, partPictureBody, partsInOrder } from '../ui/part-picture';
import { logoSVG, snapPixels } from '../ui/px';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

snapPixels();
logoSVG($('logo') as unknown as SVGSVGElement);

function gone(title: string, text: string): void {
  $('shared').hidden = true;
  $('gone-t').textContent = title;
  $('gone-p').textContent = text;
  $('gone').hidden = false;
  document.title = `${title} – Bredbord`;
  done();
}

function done(): void {
  $('page').removeAttribute('aria-busy');
  document.body.classList.add('ready');
}

async function show(): Promise<void> {
  const code = codeFromPath(location.pathname);
  if (!code) {
    gone('This isn’t a circuit link', 'Check that the whole link was copied, then try again.');
    return;
  }
  const result = await circuitByLink(code);
  if (result.kind === 'unavailable') {
    gone('Shared circuits aren’t available here', 'This copy of Bredbord isn’t connected to shared circuits.');
    return;
  }
  if (result.kind === 'offline') {
    gone('Couldn’t load this circuit', 'Check your connection, then reload the page.');
    return;
  }
  if (result.kind === 'missing') {
    gone(
      'This circuit isn’t available',
      'Its maker may have deleted it or made it private, or it may have been hidden.',
    );
    return;
  }

  const c = result.circuit;
  const title = c.title.trim() || 'Untitled circuit';
  document.title = `${title} – Bredbord`;
  $('title').textContent = title;

  const maker = $('maker');
  maker.textContent = c.maker ? `By ${c.maker.username}` : 'By someone on Bredbord';
  if (c.is_remix) maker.append(document.createTextNode(', a remix'));

  const desc = $('desc');
  desc.textContent = c.description.trim();
  desc.hidden = !desc.textContent;

  const pic = $('pic');
  const { pictureUrl } = await import('../community/supabase');
  const src = pictureUrl(c.picture_path, c.updated_at);
  if (src) {
    const img = new Image();
    img.alt = `A picture of ${title}`;
    img.decoding = 'async';
    img.onload = () => img.classList.add('in');
    img.onerror = () => img.remove();
    img.src = src;
    pic.append(img);
  }

  const list = partsInOrder(c.parts ?? {});
  const ul = $('parts');
  for (const { id, count } of list) {
    const li = document.createElement('li');
    li.innerHTML = `<svg viewBox="0 0 64 48" aria-hidden="true">${partPictureBody(id)}</svg>`;
    const name = document.createElement('span');
    name.textContent = partName(id);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = `× ${count}`;
    li.append(name, n);
    ul.append(li);
  }
  $('parts-box').hidden = list.length === 0;

  $<HTMLAnchorElement>('open').href = `/app/?c=${encodeURIComponent(code)}`;
  $('acts').hidden = false;
  done();
}

void show();
