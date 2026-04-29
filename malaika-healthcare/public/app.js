/* Malaika Healthcare — frontend */

let services = [];
let doctors = [];

// ─── Navigation ──────────────────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('section-' + name);
  if (el) {
    el.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (name === 'appointments') loadAppointments();
}

function toggleNav() {
  document.getElementById('nav-mobile').classList.toggle('open');
}

// ─── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadServices(), loadDoctors()]);
  setMinBookingDate();

  // Show section from hash or default to home
  const hash = location.hash.replace('#', '') || 'home';
  showSection(hash);
});

// ─── Services ────────────────────────────────────────────────────
async function loadServices() {
  try {
    const res = await fetch('/api/services');
    services = await res.json();
    renderServicesPage();
    renderServicesHome();
    populateServiceSelect();
  } catch (e) {
    console.error('Failed to load services', e);
  }
}

function renderServicesPage() {
  const grid = document.getElementById('services-grid');
  grid.innerHTML = services.map(s => `
    <div class="service-card" onclick="bookService('${s.name}')">
      <div class="service-icon">${s.icon}</div>
      <div>
        <div class="service-name">${s.name}</div>
        <div class="service-duration">${s.duration} min session</div>
        <div class="service-price">KES ${s.price.toLocaleString()}</div>
      </div>
    </div>
  `).join('');
}

function renderServicesHome() {
  const grid = document.getElementById('home-services-grid');
  grid.innerHTML = services.slice(0, 8).map(s => `
    <div class="service-preview-card" onclick="bookService('${s.name}')">
      <div class="spc-icon">${s.icon}</div>
      <div class="spc-name">${s.name}</div>
    </div>
  `).join('');
}

function populateServiceSelect() {
  const sel = document.getElementById('bk-service');
  services.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.icon} ${s.name} — KES ${s.price.toLocaleString()}`;
    sel.appendChild(opt);
  });
}

function bookService(name) {
  document.getElementById('bk-service').value = name;
  showSection('appointments');
}

// ─── Doctors ─────────────────────────────────────────────────────
async function loadDoctors() {
  try {
    const res = await fetch('/api/doctors');
    doctors = await res.json();
    renderDoctorsPage();
    populateDoctorSelect();
  } catch (e) {
    console.error('Failed to load doctors', e);
  }
}

function renderDoctorsPage() {
  const grid = document.getElementById('doctors-grid');
  grid.innerHTML = doctors.map(d => `
    <div class="doctor-card">
      <div class="doctor-avatar">${d.avatar}</div>
      <div class="doctor-name">${d.name}</div>
      <div class="doctor-specialty">${d.specialty}</div>
      <div class="doctor-exp">${d.experience} years experience</div>
      <button class="btn btn-outline btn-sm doctor-book-btn" onclick="bookDoctor('${d.name}')">Book Appointment</button>
    </div>
  `).join('');
}

function populateDoctorSelect() {
  const sel = document.getElementById('bk-doctor');
  doctors.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.name;
    opt.textContent = `${d.avatar} ${d.name} — ${d.specialty}`;
    sel.appendChild(opt);
  });
}

function bookDoctor(name) {
  document.getElementById('bk-doctor').value = name;
  showSection('appointments');
}

// ─── Appointment form ─────────────────────────────────────────────
function setMinBookingDate() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('bk-date').min = today;
}

async function submitBooking(e) {
  e.preventDefault();
  const btn = document.getElementById('bk-submit');
  const status = document.getElementById('bk-status');

  btn.disabled = true;
  btn.textContent = 'Booking...';
  status.className = 'form-status';
  status.textContent = '';

  const payload = {
    name: document.getElementById('bk-name').value.trim(),
    email: document.getElementById('bk-email').value.trim(),
    phone: document.getElementById('bk-phone').value.trim(),
    service: document.getElementById('bk-service').value,
    doctor: document.getElementById('bk-doctor').value,
    date: document.getElementById('bk-date').value,
    time: document.getElementById('bk-time').value,
    notes: document.getElementById('bk-notes').value.trim(),
  };

  try {
    const res = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Booking failed');

    status.className = 'form-status success';
    status.textContent = 'Appointment booked successfully!';
    document.getElementById('booking-form').reset();
    setMinBookingDate();
    showToast('Appointment booked!', 'success');
    loadAppointments();
  } catch (err) {
    status.className = 'form-status error';
    status.textContent = err.message;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm Booking';
  }
}

// ─── Appointments list ────────────────────────────────────────────
async function loadAppointments() {
  const list = document.getElementById('appointments-list');
  list.innerHTML = '<p class="empty-hint">Loading...</p>';
  try {
    const res = await fetch('/api/appointments');
    const appts = await res.json();
    if (appts.length === 0) {
      list.innerHTML = '<p class="empty-hint">No appointments yet.</p>';
      return;
    }
    list.innerHTML = appts.map(a => `
      <div class="appt-item" onclick="showApptDetail(${a.id})">
        <div class="appt-icon">📋</div>
        <div class="appt-info">
          <div class="appt-name">${escHtml(a.name)}</div>
          <div class="appt-meta">${escHtml(a.service)} · ${formatDate(a.date)} ${formatTime(a.time)}</div>
        </div>
        <span class="appt-badge ${a.status}">${a.status}</span>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = '<p class="empty-hint">Failed to load appointments.</p>';
  }
}

function showApptDetail(id) {
  fetch('/api/appointments')
    .then(r => r.json())
    .then(appts => {
      const a = appts.find(x => x.id === id);
      if (!a) return;
      const body = document.getElementById('appt-modal-body');
      body.innerHTML = `
        <div class="appt-detail-row"><span class="appt-detail-label">Patient</span><span class="appt-detail-val">${escHtml(a.name)}</span></div>
        <div class="appt-detail-row"><span class="appt-detail-label">Email</span><span class="appt-detail-val">${escHtml(a.email)}</span></div>
        <div class="appt-detail-row"><span class="appt-detail-label">Phone</span><span class="appt-detail-val">${escHtml(a.phone || '—')}</span></div>
        <div class="appt-detail-row"><span class="appt-detail-label">Service</span><span class="appt-detail-val">${escHtml(a.service)}</span></div>
        <div class="appt-detail-row"><span class="appt-detail-label">Doctor</span><span class="appt-detail-val">${escHtml(a.doctor || 'Any available')}</span></div>
        <div class="appt-detail-row"><span class="appt-detail-label">Date & Time</span><span class="appt-detail-val">${formatDate(a.date)} at ${formatTime(a.time)}</span></div>
        <div class="appt-detail-row"><span class="appt-detail-label">Status</span><span class="appt-badge ${a.status}">${a.status}</span></div>
        ${a.notes ? `<div class="appt-detail-row"><span class="appt-detail-label">Notes</span><span class="appt-detail-val">${escHtml(a.notes)}</span></div>` : ''}
      `;
      document.getElementById('modal-cancel-btn').onclick = () => cancelAppointment(id);
      document.getElementById('appt-modal').style.display = 'flex';
    });
}

function closeApptModal() {
  document.getElementById('appt-modal').style.display = 'none';
}

function closeModal(e) {
  if (e.target === document.getElementById('appt-modal')) closeApptModal();
}

async function cancelAppointment(id) {
  if (!confirm('Cancel this appointment?')) return;
  try {
    await fetch(`/api/appointments/${id}`, { method: 'DELETE' });
    closeApptModal();
    loadAppointments();
    showToast('Appointment cancelled', 'success');
  } catch (e) {
    showToast('Failed to cancel appointment', 'error');
  }
}

// ─── Contact form ─────────────────────────────────────────────────
async function submitContact(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const status = document.getElementById('ct-status');

  btn.disabled = true;
  btn.textContent = 'Sending...';
  status.className = 'form-status';
  status.textContent = '';

  const payload = {
    name: document.getElementById('ct-name').value.trim(),
    email: document.getElementById('ct-email').value.trim(),
    subject: document.getElementById('ct-subject').value.trim(),
    message: document.getElementById('ct-message').value.trim(),
  };

  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send');

    status.className = 'form-status success';
    status.textContent = 'Message sent! We\'ll get back to you shortly.';
    document.getElementById('contact-form').reset();
    showToast('Message sent!', 'success');
  } catch (err) {
    status.className = 'form-status error';
    status.textContent = err.message;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Message';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

let toastTimer;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}
