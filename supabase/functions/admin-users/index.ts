// AccountIQ — Admin Users Edge Function
// File: supabase/functions/admin-users/index.ts
//
// Deploy:  supabase functions deploy admin-users --no-verify-jwt
// Handles: create user, update user details

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify caller is authenticated ──────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify the calling user's JWT
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Verify caller is admin ───────────────────────────
    const { data: callerProfile } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .single();

    if (callerProfile?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 3. Admin client with service role ──────────────────
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const { action } = body;

    // ── 4. CREATE USER ──────────────────────────────────────
    if (action === "create") {
      const { email, password, fullName, role } = body;
      if (!email || !password) {
        return new Response(JSON.stringify({ error: "Email and password required" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      if (password.length < 8) {
        return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Create auth user
      const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // skip email confirmation
        user_metadata: { full_name: fullName || "" },
      });

      if (createErr) {
        return new Response(JSON.stringify({ error: createErr.message }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Create profile
      await adminClient.from("profiles").upsert({
        id: newUser.user.id,
        email,
        full_name: fullName || "",
        role: role || "user",
      });

      return new Response(JSON.stringify({
        success: true,
        user: {
          id: newUser.user.id,
          email,
          full_name: fullName || "",
          role: role || "user",
          created_at: newUser.user.created_at,
          last_sign_in_at: null,
        }
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── 5. UPDATE USER ──────────────────────────────────────
    if (action === "update") {
      const { userId, email, password, fullName, role } = body;
      if (!userId) {
        return new Response(JSON.stringify({ error: "userId required" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Build auth update payload
      const authUpdate: Record<string, unknown> = {};
      if (email) authUpdate.email = email;
      if (password && password.length >= 8) authUpdate.password = password;
      if (fullName !== undefined) authUpdate.user_metadata = { full_name: fullName };

      if (Object.keys(authUpdate).length > 0) {
        const { error: updateErr } = await adminClient.auth.admin.updateUserById(userId, authUpdate);
        if (updateErr) {
          return new Response(JSON.stringify({ error: updateErr.message }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" },
          });
        }
      }

      // Update profile
      const profileUpdate: Record<string, unknown> = {};
      if (fullName !== undefined) profileUpdate.full_name = fullName;
      if (email) profileUpdate.email = email;
      if (role) profileUpdate.role = role;

      if (Object.keys(profileUpdate).length > 0) {
        await adminClient.from("profiles").update(profileUpdate).eq("id", userId);
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 6. DELETE USER ──────────────────────────────────────
    if (action === "delete") {
      const { userId } = body;
      if (!userId) {
        return new Response(JSON.stringify({ error: "userId required" }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Delete accounts first
      await adminClient.from("accounts").delete().eq("user_id", userId);
      // Delete profile
      await adminClient.from("profiles").delete().eq("id", userId);
      // Delete auth user
      const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
      if (delErr) {
        return new Response(JSON.stringify({ error: delErr.message }), {
          status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("admin-users error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});