const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Data persistence ───────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading data.json:', e.message);
  }
  return { appointments: [], patients: [], messages: [] };
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error writing data.json:', e.message);
  }
}

// Seed initial data if empty
(function seedIfEmpty() {
  const data = readData();
  if (data.patients.length === 0) {
    data.patients = [
      { id: 1, name: 'Alice Mwangi', email: 'alice@example.com', dob: '1985-03-12', phone: '+254 700 123 456' },
      { id: 2, name: 'Brian Otieno', email: 'brian@example.com', dob: '1990-07-25', phone: '+254 711 234 567' },
    ];
    writeData(data);
  }
})();

// ─── Services endpoint ───────────────────────────────────────────
const SERVICES = [
  { id: 1, name: 'General Consultation', duration: 30, price: 1500, icon: '🩺' },
  { id: 2, name: 'Dental Care', duration: 45, price: 2500, icon: '🦷' },
  { id: 3, name: 'Eye Examination', duration: 30, price: 2000, icon: '👁' },
  { id: 4, name: 'Pediatrics', duration: 30, price: 1800, icon: '👶' },
  { id: 5, name: 'Mental Health', duration: 60, price: 3000, icon: '🧠' },
  { id: 6, name: 'Physiotherapy', duration: 60, price: 2800, icon: '💪' },
  { id: 7, name: 'Laboratory Tests', duration: 20, price: 1200, icon: '🔬' },
  { id: 8, name: 'Vaccination', duration: 15, price: 800, icon: '💉' },
];

const DOCTORS = [
  { id: 1, name: 'Dr. Amina Wanjiku', specialty: 'General Practice', experience: 8, avatar: '👩‍⚕️' },
  { id: 2, name: 'Dr. Joseph Kamau', specialty: 'Dentistry', experience: 12, avatar: '👨‍⚕️' },
  { id: 3, name: 'Dr. Fatuma Abubakar', specialty: 'Ophthalmology', experience: 10, avatar: '👩‍⚕️' },
  { id: 4, name: 'Dr. Peter Njoroge', specialty: 'Pediatrics', experience: 15, avatar: '👨‍⚕️' },
  { id: 5, name: 'Dr. Grace Odhiambo', specialty: 'Mental Health', experience: 7, avatar: '👩‍⚕️' },
];

app.get('/api/services', (req, res) => res.json(SERVICES));
app.get('/api/doctors', (req, res) => res.json(DOCTORS));

// ─── Appointments ─────────────────────────────────────────────────
app.get('/api/appointments', (req, res) => {
  res.json(readData().appointments);
});

app.post('/api/appointments', (req, res) => {
  const { name, email, phone, service, doctor, date, time, notes } = req.body;
  if (!name || !email || !service || !date || !time) {
    return res.status(400).json({ error: 'name, email, service, date and time are required' });
  }
  const data = readData();
  const appointment = {
    id: Date.now(),
    name, email, phone: phone || '',
    service, doctor: doctor || '',
    date, time, notes: notes || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  data.appointments.push(appointment);
  writeData(data);
  res.json({ success: true, appointment });
});

app.patch('/api/appointments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const data = readData();
  const idx = data.appointments.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Appointment not found' });
  data.appointments[idx] = { ...data.appointments[idx], ...req.body };
  writeData(data);
  res.json({ success: true, appointment: data.appointments[idx] });
});

app.delete('/api/appointments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const data = readData();
  data.appointments = data.appointments.filter(a => a.id !== id);
  writeData(data);
  res.json({ success: true });
});

// ─── Contact / messages ───────────────────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'name, email and message are required' });
  }
  const data = readData();
  data.messages.push({ id: Date.now(), name, email, subject: subject || '', message, createdAt: new Date().toISOString() });
  writeData(data);
  res.json({ success: true });
});

// ─── SPA fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Malaika Healthcare running on http://localhost:${PORT}`);
});
