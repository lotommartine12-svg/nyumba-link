// ============================================================
// NYUMBALINK SUPABASE CONNECTION & ALL API FUNCTIONS
// File: supabase-client.js
// Add this <script> to every HTML page:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// <script src="supabase-client.js"></script>
// ============================================================

// ── STEP 1: ADD YOUR REAL KEYS FROM supabase.com ──
const SUPABASE_URL = 'https://cqxeraovwxlmevvyjtng.supabase.co/rest/v1/';   // Replace this
const SUPABASE_ANON_KEY = 'sb_publishable_bYCBupOquxymPjm_007iKg_B-qXkivU';            // Replace this

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// ── AUTH: LOGIN & LOGOUT ──
// ============================================================

async function loginTenant(phone, password) {
  // Tenants log in with phone as "email" convention
  const email = phone.replace(/\s/g, '') + '@nyumbalink.tenant';
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Invalid phone or password');

  // Fetch full tenant record
  const { data: tenant } = await supabase
    .from('tenants')
    .select('*, units(*), properties(*)')
    .eq('id', data.user.id)
    .single();

  localStorage.setItem('nl_tenant', JSON.stringify(tenant));
  return tenant;
}

async function loginLandlord(phone, password) {
  const email = phone.replace(/\s/g, '') + '@nyumbalink.landlord';
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Invalid credentials');

  const { data: landlord } = await supabase
    .from('landlords')
    .select('*, properties(*)')
    .eq('id', data.user.id)
    .single();

  localStorage.setItem('nl_landlord', JSON.stringify(landlord));
  return landlord;
}

async function logout() {
  await supabase.auth.signOut();
  localStorage.removeItem('nl_tenant');
  localStorage.removeItem('nl_landlord');
  window.location.href = 'index.html';
}

function getCurrentTenant() {
  return JSON.parse(localStorage.getItem('nl_tenant') || 'null');
}

function getCurrentLandlord() {
  return JSON.parse(localStorage.getItem('nl_landlord') || 'null');
}


// ============================================================
// ── LANDLORD: PROPERTY SETUP ──
// ============================================================

async function createProperty(landlordId, data) {
  const { data: property, error } = await supabase
    .from('properties')
    .insert({
      landlord_id: landlordId,
      name: data.name,
      address: data.address,
      county: data.county,
      town: data.town,
      total_units: data.totalUnits,
      water_rate_per_m3: data.waterRate || 85,
      garbage_fee: data.garbageFee || 500,
      late_penalty_per_day: data.penaltyPerDay || 20,
      rent_due_day: data.rentDueDay || 10,
      mpesa_paybill: data.paybill
    })
    .select()
    .single();

  if (error) throw error;

  // Update landlord total_properties count
  await supabase.rpc('increment_landlord_properties', { landlord_id: landlordId });
  return property;
}

async function addUnit(propertyId, unitNumber, monthlyRent, unitType) {
  const { data, error } = await supabase
    .from('units')
    .insert({ property_id: propertyId, unit_number: unitNumber, monthly_rent: monthlyRent, unit_type: unitType })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getPropertyUnits(propertyId) {
  const { data, error } = await supabase
    .from('units')
    .select('*, tenants(*)')
    .eq('property_id', propertyId)
    .order('unit_number');
  if (error) throw error;
  return data;
}


// ============================================================
// ── LANDLORD: ENROLL TENANT ──
// ============================================================

async function enrollTenant(landlordId, propertyId, unitId, tenantData) {
  // 1. Create auth user in Supabase
  const email = tenantData.phone.replace(/\s/g, '') + '@nyumbalink.tenant';
  const tempPassword = 'NL' + Math.random().toString(36).slice(2, 8).toUpperCase();

  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true
  });
  if (authError) throw authError;

  // 2. Create tenant record
  const { data: tenant, error } = await supabase
    .from('tenants')
    .insert({
      id: authUser.user.id,
      property_id: propertyId,
      unit_id: unitId,
      landlord_id: landlordId,
      name: tenantData.name,
      phone: tenantData.phone,
      national_id: tenantData.nationalId,
      move_in_date: tenantData.moveInDate,
      deposit_amount: tenantData.deposit,
      deposit_paid: true
    })
    .select()
    .single();
  if (error) throw error;

  // 3. Mark unit as occupied
  await supabase.from('units').update({
    status: 'occupied',
    current_tenant_id: tenant.id
  }).eq('id', unitId);

  // 4. Send welcome SMS (calls your backend)
  await sendWelcomeSMS(tenantData.phone, tenantData.name, unitId, tempPassword);

  // 5. Create welcome notification
  await createNotification(tenant.id, null, propertyId, {
    title: 'Welcome to NyumbaLink! 🏠',
    body: `Your tenant portal is ready. Login with phone: ${tenantData.phone} and your temporary password.`,
    type: 'success'
  });

  return tenant;
}


// ============================================================
// ── PAYMENTS ──
// ============================================================

async function recordPayment(tenantId, unitId, propertyId, landlordId, paymentData) {
  const { data, error } = await supabase
    .from('payments')
    .insert({
      tenant_id: tenantId,
      unit_id: unitId,
      property_id: propertyId,
      landlord_id: landlordId,
      amount: paymentData.amount,
      payment_type: paymentData.type,       // 'rent','water','garbage'
      payment_method: paymentData.method,   // 'mpesa','bank','cash'
      mpesa_reference: paymentData.mpesaRef,
      period_month: paymentData.month,
      period_year: paymentData.year,
      status: 'confirmed'
    })
    .select()
    .single();

  if (error) throw error;

  // Update Rent Score if rent payment
  if (paymentData.type === 'rent') {
    await updateRentScore(tenantId, paymentData.daysLate || 0);
  }

  // Send SMS receipt
  await sendReceiptSMS(tenantId, data.receipt_number, paymentData.amount);

  return data;
}

async function getTenantPayments(tenantId) {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function getPropertyPayments(propertyId, month, year) {
  const { data, error } = await supabase
    .from('payments')
    .select('*, tenants(name, phone), units(unit_number)')
    .eq('property_id', propertyId)
    .eq('period_month', month)
    .eq('period_year', year);
  if (error) throw error;
  return data;
}

async function checkRentPaid(tenantId, month, year) {
  const { data } = await supabase
    .from('payments')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('payment_type', 'rent')
    .eq('period_month', month)
    .eq('period_year', year)
    .eq('status', 'confirmed')
    .limit(1);
  return data && data.length > 0;
}


// ============================================================
// ── WATER BILLING ──
// ============================================================

async function recordWaterReading(unitId, propertyId, tenantId, prevReading, currReading, ratePerM3, month, year) {
  const { data, error } = await supabase
    .from('water_readings')
    .insert({
      unit_id: unitId,
      property_id: propertyId,
      tenant_id: tenantId,
      previous_reading: prevReading,
      current_reading: currReading,
      rate_per_m3: ratePerM3,
      reading_date: new Date().toISOString().split('T')[0],
      period_month: month,
      period_year: year,
      status: 'billed'
    })
    .select()
    .single();

  if (error) throw error;

  // Auto-create payment record for water
  await recordPayment(tenantId, unitId, propertyId, null, {
    amount: data.bill_amount,
    type: 'water',
    method: 'pending',
    month, year
  });

  // Notify tenant
  await createNotification(tenantId, null, propertyId, {
    title: `💧 Water Bill Ready – ${getMonthName(month)} ${year}`,
    body: `Your water bill is KES ${data.bill_amount.toFixed(0)} (${data.units_consumed} m³ used). Due by ${year}-${String(month).padStart(2,'0')}-20.`,
    type: 'info'
  });

  return data;
}

async function getTenantWaterHistory(tenantId) {
  const { data, error } = await supabase
    .from('water_readings')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('reading_date', { ascending: false });
  if (error) throw error;
  return data;
}


// ============================================================
// ── REPAIRS ──
// ============================================================

async function submitRepair(tenantId, unitId, propertyId, landlordId, repairData) {
  const { data, error } = await supabase
    .from('repairs')
    .insert({
      tenant_id: tenantId,
      unit_id: unitId,
      property_id: propertyId,
      landlord_id: landlordId,
      category: repairData.category,
      title: repairData.title,
      description: repairData.description,
      priority: repairData.priority,
      status: 'open'
    })
    .select()
    .single();

  if (error) throw error;

  // Add first timeline entry
  await supabase.from('repair_timeline').insert({
    repair_id: data.id,
    status: 'submitted',
    note: 'Complaint submitted by tenant',
    updated_by: 'tenant'
  });

  // Notify landlord
  await createNotification(null, landlordId, propertyId, {
    title: `🔧 New ${repairData.priority === 'urgent' ? 'URGENT ' : ''}Repair – ${repairData.category}`,
    body: `Unit ${unitId}: ${repairData.title}. Priority: ${repairData.priority}.`,
    type: repairData.priority === 'urgent' ? 'danger' : 'warning'
  });

  return data;
}

async function assignTechnician(repairId, technicianId, scheduledDate) {
  const { data, error } = await supabase
    .from('repairs')
    .update({
      technician_id: technicianId,
      status: 'assigned',
      assigned_at: new Date().toISOString()
    })
    .eq('id', repairId)
    .select('*, tenants(phone, name), technicians(name, phone)')
    .single();

  if (error) throw error;

  // Add timeline entry
  await supabase.from('repair_timeline').insert({
    repair_id: repairId,
    status: 'assigned',
    note: `Technician ${data.technicians.name} assigned. Visit: ${scheduledDate}`,
    updated_by: 'landlord'
  });

  // Notify tenant
  await createNotification(data.tenant_id, null, data.property_id, {
    title: '🔧 Technician Assigned!',
    body: `${data.technicians.name} will visit on ${scheduledDate}. Direct contact: ${data.technicians.phone}`,
    type: 'success'
  });

  return data;
}

async function getTenantRepairs(tenantId) {
  const { data, error } = await supabase
    .from('repairs')
    .select('*, technicians(name, phone, specialties), repair_timeline(*)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}


// ============================================================
// ── NOTIFICATIONS ──
// ============================================================

async function createNotification(tenantId, landlordId, propertyId, notifData) {
  await supabase.from('notifications').insert({
    tenant_id: tenantId,
    landlord_id: landlordId,
    property_id: propertyId,
    title: notifData.title,
    body: notifData.body,
    type: notifData.type || 'info'
  });
}

async function getTenantNotifications(tenantId) {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

async function markNotificationsRead(tenantId) {
  await supabase.from('notifications')
    .update({ is_read: true })
    .eq('tenant_id', tenantId)
    .eq('is_read', false);
}


// ============================================================
// ── RENT SCORE ──
// ============================================================

async function updateRentScore(tenantId, daysLate) {
  const { data: tenant } = await supabase
    .from('tenants')
    .select('rent_score')
    .eq('id', tenantId)
    .single();

  let newScore = tenant.rent_score;

  if (daysLate === 0) {
    newScore = Math.min(850, newScore + 8);    // +8 for on-time payment
  } else if (daysLate <= 3) {
    newScore = Math.max(300, newScore - 15);   // -15 for up to 3 days late
  } else if (daysLate <= 7) {
    newScore = Math.max(300, newScore - 30);   // -30 for 4-7 days late
  } else {
    newScore = Math.max(300, newScore - 50);   // -50 for more than a week late
  }

  await supabase.from('tenants')
    .update({ rent_score: newScore })
    .eq('id', tenantId);

  return newScore;
}


// ============================================================
// ── COMMUNITY BOARD ──
// ============================================================

async function createPost(propertyId, authorId, isLandlord, postData) {
  const { data, error } = await supabase
    .from('community_posts')
    .insert({
      property_id: propertyId,
      posted_by_tenant: isLandlord ? null : authorId,
      posted_by_landlord: isLandlord ? authorId : null,
      is_landlord_post: isLandlord,
      category: postData.category,
      title: postData.title,
      body: postData.body
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getPropertyPosts(propertyId) {
  const { data, error } = await supabase
    .from('community_posts')
    .select('*, tenants(name), landlords(name)')
    .eq('property_id', propertyId)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}


// ============================================================
// ── LEASE ──
// ============================================================

async function createLease(tenantId, unitId, propertyId, landlordId, leaseData) {
  const { data, error } = await supabase
    .from('leases')
    .insert({
      tenant_id: tenantId,
      unit_id: unitId,
      property_id: propertyId,
      landlord_id: landlordId,
      monthly_rent: leaseData.monthlyRent,
      deposit: leaseData.deposit,
      start_date: leaseData.startDate,
      end_date: leaseData.endDate,
      status: 'pending_signature'
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getTenantLease(tenantId) {
  const { data, error } = await supabase
    .from('leases')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return data;
}


// ============================================================
// ── REAL-TIME SUBSCRIPTIONS ──
// ============================================================

// Listen for new notifications in real-time (tenant dashboard)
function subscribeToNotifications(tenantId, callback) {
  return supabase
    .channel('tenant-notifications')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: `tenant_id=eq.${tenantId}`
    }, callback)
    .subscribe();
}

// Listen for repair status updates
function subscribeToRepairUpdates(tenantId, callback) {
  return supabase
    .channel('repair-updates')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'repairs',
      filter: `tenant_id=eq.${tenantId}`
    }, callback)
    .subscribe();
}

// Listen for new payments (landlord dashboard)
function subscribeToPayments(propertyId, callback) {
  return supabase
    .channel('new-payments')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'payments',
      filter: `property_id=eq.${propertyId}`
    }, callback)
    .subscribe();
}


// ============================================================
// ── ANALYTICS / REPORTS ──
// ============================================================

async function getPropertyStats(propertyId) {
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();

  const [unitsData, paymentsData, repairsData] = await Promise.all([
    supabase.from('units').select('status').eq('property_id', propertyId),
    supabase.from('payments').select('amount, payment_type').eq('property_id', propertyId).eq('period_month', currentMonth).eq('period_year', currentYear),
    supabase.from('repairs').select('status').eq('property_id', propertyId)
  ]);

  const units = unitsData.data || [];
  const payments = paymentsData.data || [];
  const repairs = repairsData.data || [];

  return {
    totalUnits: units.length,
    occupiedUnits: units.filter(u => u.status === 'occupied').length,
    vacantUnits: units.filter(u => u.status === 'vacant').length,
    occupancyRate: Math.round(units.filter(u => u.status === 'occupied').length / units.length * 100),
    totalCollected: payments.filter(p => p.payment_type === 'rent').reduce((sum, p) => sum + Number(p.amount), 0),
    openRepairs: repairs.filter(r => r.status === 'open').length,
    inProgressRepairs: repairs.filter(r => r.status === 'in_progress').length
  };
}


// ============================================================
// ── HELPERS ──
// ============================================================

function getMonthName(month) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month - 1];
}

async function sendWelcomeSMS(phone, name, unitNumber, tempPassword) {
  try {
    await fetch('/api/sms/welcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name, unitNumber, tempPassword })
    });
  } catch (e) {
    console.log('SMS service unavailable — skipping welcome SMS');
  }
}

async function sendReceiptSMS(tenantId, receiptNumber, amount) {
  try {
    const tenant = await supabase.from('tenants').select('phone, name').eq('id', tenantId).single();
    await fetch('/api/sms/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: tenant.data.phone,
        name: tenant.data.name,
        receiptNumber,
        amount
      })
    });
  } catch (e) {
    console.log('SMS receipt not sent — service unavailable');
  }
}

// Export all functions for use in HTML pages
window.NL = {
  loginTenant, loginLandlord, logout,
  getCurrentTenant, getCurrentLandlord,
  createProperty, addUnit, getPropertyUnits,
  enrollTenant,
  recordPayment, getTenantPayments, getPropertyPayments, checkRentPaid,
  recordWaterReading, getTenantWaterHistory,
  submitRepair, assignTechnician, getTenantRepairs,
  createNotification, getTenantNotifications, markNotificationsRead,
  updateRentScore,
  createPost, getPropertyPosts,
  createLease, getTenantLease,
  subscribeToNotifications, subscribeToRepairUpdates, subscribeToPayments,
  getPropertyStats
};

console.log('✅ NyumbaLink Supabase client loaded. Use window.NL to call any function.');
