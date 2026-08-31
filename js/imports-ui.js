import { importFile, guessHeightMapping, guessNameField } from './data/import/index.js';
import { IMPORT_TARGETS, defaultMapping, heightSummary } from './data/import/merge.js';
import { saveDataset, loadDatasets, deleteDataset } from './data/import/store.js';

const UNITS = [
  { id: 'm', label: 'metres' },
  { id: 'ft', label: 'feet' },
  { id: 'levels', label: 'storeys' },
];

export class ImportsPanel {
  constructor(handlers) {
    this.handlers = handlers;
    this.datasets = [];

    this.dropzone = document.getElementById('dropzone');
    this.input = document.getElementById('import-input');
    this.list = document.getElementById('dataset-list');

    this.dropzone.addEventListener('click', () => this.input.click());
    this.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.input.click();
      }
    });
    this.input.addEventListener('change', () => {
      this.add(this.input.files);
      this.input.value = '';
    });

    this._wireDragAndDrop();
  }

  _wireDragAndDrop() {
    let depth = 0;
    const over = (on) => this.dropzone.classList.toggle('is-over', on);

    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      depth++;
      over(true);
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) over(false);
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      depth = 0;
      over(false);
      this.add(e.dataTransfer.files);
    });
  }

  async restore() {
    const saved = await loadDatasets();
    if (!saved.length) return;
    this.datasets = saved;
    this.render();
    this.handlers.onChange?.(this.datasets);
  }

  async add(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;

    this.dropzone.classList.add('is-busy');
    let imported = 0;

    for (const file of files) {
      try {
        const dataset = await importFile(file);
        const mapping = defaultMapping(dataset);

        if (mapping.part === 'buildings') {
          const guess = guessHeightMapping(dataset.fields);
          mapping.heightField = guess.field;
          mapping.heightUnit = guess.unit;
        }
        mapping.nameField = guessNameField(dataset.fields);
        dataset.mapping = mapping;

        this.datasets.push(dataset);
        await saveDataset(dataset);
        imported++;

        this.handlers.onMessage?.(
          `Loaded ${dataset.count.toLocaleString()} ${dataset.kind === 'point' ? 'points' : dataset.kind === 'line' ? 'lines' : 'shapes'} from ${dataset.name}` +
            (dataset.crsName ? ` (reprojected from ${dataset.crsName})` : ''),
          'good'
        );
      } catch (err) {
        this.handlers.onMessage?.(`${file.name}: ${err.message}`, 'bad');
      }
    }

    this.dropzone.classList.remove('is-busy');
    if (!imported) return;

    this.render();
    this.handlers.onChange?.(this.datasets);
    this.handlers.onFocus?.(this.datasets[this.datasets.length - 1].bbox);
  }

  async remove(id) {
    this.datasets = this.datasets.filter((d) => d.id !== id);
    await deleteDataset(id);
    this.render();
    this.handlers.onChange?.(this.datasets);
  }

  update(id, patch) {
    const dataset = this.datasets.find((d) => d.id === id);
    if (!dataset) return;
    Object.assign(dataset.mapping, patch);
    saveDataset(dataset);
    this.render();
    this.handlers.onChange?.(this.datasets);
  }

  render() {
    this.list.innerHTML = '';
    for (const dataset of this.datasets) {
      this.list.appendChild(this.renderDataset(dataset));
    }
  }

  renderDataset(dataset) {
    const mapping = dataset.mapping;
    const li = document.createElement('li');
    li.className = 'dataset';

    const head = document.createElement('div');
    head.className = 'dataset-head';

    const enabled = el('input', { type: 'checkbox', checked: mapping.enabled !== false });
    enabled.addEventListener('change', () => this.update(dataset.id, { enabled: enabled.checked }));

    const title = document.createElement('div');
    title.className = 'dataset-title';
    const name = el('span', { className: 'dataset-name', textContent: dataset.name, title: dataset.name });
    const meta = el('span', {
      className: 'dataset-meta',
      textContent: [
        dataset.format,
        `${dataset.count.toLocaleString()} ${dataset.kind === 'point' ? 'points' : dataset.kind === 'line' ? 'lines' : 'shapes'}`,
        dataset.crsName || null,
      ].filter(Boolean).join(' · '),
    });
    title.append(name, meta);

    const focus = el('button', {
      className: 'dataset-drop', type: 'button', textContent: '⌖', title: 'Move the plate to this data',
    });
    focus.addEventListener('click', () => this.handlers.onFocus?.(dataset.bbox));

    const drop = el('button', {
      className: 'dataset-drop', type: 'button', textContent: '×', title: 'Remove',
    });
    drop.addEventListener('click', () => this.remove(dataset.id));

    head.append(enabled, title, focus, drop);
    li.append(head);

    const grid = document.createElement('div');
    grid.className = 'dataset-grid';

    const targets = IMPORT_TARGETS.filter((t) => t.accepts.includes(dataset.kind) || dataset.kind === 'mixed');
    grid.append(
      labelled('Use as', select(
        (targets.length ? targets : IMPORT_TARGETS).map((t) => ({ value: t.id, label: t.label })),
        mapping.part,
        (value) => this.update(dataset.id, { part: value })
      )),
      labelled('Existing map data', select(
        [
          { value: 'replace', label: 'Replace here' },
          { value: 'add', label: 'Keep both' },
        ],
        mapping.mode,
        (value) => this.update(dataset.id, { mode: value })
      ))
    );
    li.append(grid);

    if (mapping.part === 'buildings') {
      const numeric = dataset.fields.filter((f) => f.type === 'number');
      const heightGrid = document.createElement('div');
      heightGrid.className = 'dataset-grid';

      heightGrid.append(
        labelled('Height from', select(
          [{ value: '', label: numeric.length ? 'Same for all' : 'No numeric columns' },
            ...numeric.map((f) => ({ value: f.name, label: f.name }))],
          mapping.heightField || '',
          (value) => this.update(dataset.id, { heightField: value || null })
        )),
        mapping.heightField
          ? labelled('Measured in', select(
              UNITS.map((u) => ({ value: u.id, label: u.label })),
              mapping.heightUnit,
              (value) => this.update(dataset.id, { heightUnit: value })
            ))
          : labelled('Height', number(mapping.defaultHeight, 1, 300, 0.5,
              (value) => this.update(dataset.id, { defaultHeight: value })))
      );
      li.append(heightGrid);

      const summary = heightSummary(dataset, mapping);
      if (summary) {
        const note = el('p', { className: 'dataset-note' });
        note.innerHTML =
          `Heights <b>${summary.min.toFixed(1)}–${summary.max.toFixed(1)} m</b>, ` +
          `median <b>${summary.median.toFixed(1)} m</b>, ` +
          `<b>${summary.distinct}</b> distinct values.`;
        if (summary.distinct <= 2) {
          note.classList.add('is-warn');
          note.innerHTML += ' That is nearly flat — try another column.';
        } else if (summary.max > 250) {
          note.classList.add('is-warn');
          note.innerHTML += ' Over 250 m — these may be feet.';
        }
        li.append(note);
      } else if (!numeric.length) {
        li.append(el('p', {
          className: 'dataset-note',
          textContent: 'This file has no numeric columns, so every building gets the same height.',
        }));
      }
    }

    if ((mapping.part === 'roads' || mapping.part === 'water') && dataset.kind === 'line') {
      const widthGrid = document.createElement('div');
      widthGrid.className = 'dataset-grid one';
      widthGrid.append(labelled('Width on the ground (m)', number(
        mapping.widthMetres, 1, 120, 0.5,
        (value) => this.update(dataset.id, { widthMetres: value })
      )));
      li.append(widthGrid);
    }

    return li;
  }
}

function el(tag, props) {
  return Object.assign(document.createElement(tag), props);
}

function labelled(text, control) {
  const label = document.createElement('label');
  label.append(el('span', { textContent: text }), control);
  return label;
}

function select(options, value, onChange) {
  const node = document.createElement('select');
  for (const option of options) {
    node.append(el('option', { value: option.value, textContent: option.label }));
  }
  node.value = value ?? '';
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function number(value, min, max, step, onChange) {
  const node = el('input', { type: 'number', value, min, max, step });
  node.addEventListener('change', () => {
    const parsed = Number(node.value);
    if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
  });
  return node;
}
