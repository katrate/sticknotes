const { ipcRenderer } = require('electron');

let notes = JSON.parse(localStorage.getItem('sticky_db')) || [
    { id: 1, title: 'Pinned', content: 'Hover edge for icons.', color: '#00d4ff' }
];
let activeId = null;
const colors = ['#00d4ff', '#ff006e', '#8338ec', '#ffbe0b', '#06d6a0'];

// Autostart toggle
ipcRenderer.invoke('get-autostart').then((enabled) => {
    document.getElementById('autostart-toggle').checked = enabled;
});

document.getElementById('autostart-toggle').addEventListener('change', (e) => {
    ipcRenderer.send('set-autostart', e.target.checked);
});

ipcRenderer.on('autostart-changed', (event, enabled) => {
    document.getElementById('autostart-toggle').checked = enabled;
});

function render() {
    const container = document.getElementById('notes-container');
    container.innerHTML = `
        <button id="add-btn" onclick="addNote()">+</button>
        <div id="notes-list">
            ${notes.map(n => `
                <div class="note-item">
                    <div class="note-body" onclick="openEditor(${n.id})" style="border-left: 5px solid ${n.color}">
                        <button class="done-btn-card" onclick="markDoneFromCard(event, ${n.id})">DONE</button>
                        <h3>${n.title}</h3>
                        <p>${n.content}</p>
                    </div>
                    <div class="note-tab" style="background: ${n.color}"></div>
                </div>
            `).join('')}
        </div>
    `;
    localStorage.setItem('sticky_db', JSON.stringify(notes));
}

function openEditor(id) {
    activeId = id;
    const note = notes.find(n => n.id === id);
    document.getElementById('edit-title').value = note.title;
    document.getElementById('edit-content').value = note.content;
    renderColorPicker(note.color);
    document.getElementById('editor-overlay').classList.remove('hidden');
    ipcRenderer.send('set-ignore-mouse', false);
}

function renderColorPicker(selectedColor) {
    document.getElementById('color-picker').innerHTML = colors.map(c => `
        <div class="swatch ${selectedColor === c ? 'active' : ''}" 
             style="background: ${c}" 
             onclick="setNoteColor('${c}')"></div>
    `).join('');
}

function setNoteColor(c) {
    const note = notes.find(n => n.id === activeId);
    // PRESERVE TEXT: Save current input values to the object before re-rendering
    note.title = document.getElementById('edit-title').value;
    note.content = document.getElementById('edit-content').value;
    note.color = c;
    renderColorPicker(c);
    render();
}

function addNote() {
    notes.unshift({ id: Date.now(), title: 'New', content: '', color: colors[0] });
    render();
    openEditor(notes[0].id);
}

function markDoneFromCard(event, id) {
    event.stopPropagation();
    notes = notes.filter(n => n.id !== id);
    render();
}

function deleteNote() {
    notes = notes.filter(n => n.id !== activeId);
    save();
}

function save() {
    const note = notes.find(n => n.id === activeId);
    if (note) {
        note.title = document.getElementById('edit-title').value;
        note.content = document.getElementById('edit-content').value;
    }
    localStorage.setItem('sticky_db', JSON.stringify(notes));
    document.getElementById('editor-overlay').classList.add('hidden');
    render();
}

window.addEventListener('mousemove', (e) => {
    const editorOpen = !document.getElementById('editor-overlay').classList.contains('hidden');
    const overUI = e.target.closest('.note-item') || e.target.id === 'add-btn' || e.target.closest('#editor-window') || e.clientX > window.innerWidth - 10;
    ipcRenderer.send('set-ignore-mouse', editorOpen ? false : !overUI);
});

render();