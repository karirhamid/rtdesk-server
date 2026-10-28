<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Core RTDesk domain: groups, devices, client API tokens.
     * Schema informed by the production lejianwen/rustdesk-api database
     * (docs/production-api-schema.sql) and the RustDesk client contract.
     */
    public function up(): void
    {
        Schema::create('user_groups', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('note', 500)->nullable();
            $table->timestamps();
        });

        Schema::create('device_groups', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('note', 500)->nullable();
            $table->timestamps();
        });

        Schema::create('devices', function (Blueprint $table) {
            $table->id();
            // RustDesk peer identity (from /api/sysinfo + /api/heartbeat)
            $table->string('rustdesk_id')->unique();
            $table->string('uuid')->index();
            $table->string('hostname')->nullable();
            $table->string('os')->nullable();
            $table->string('cpu')->nullable();
            $table->string('memory')->nullable();
            $table->string('username')->nullable();   // OS-level user on the device
            $table->string('version', 32)->nullable(); // client version
            // Console-managed attributes
            $table->string('alias')->nullable()->index();
            $table->string('note', 500)->nullable();
            $table->foreignId('user_id')->nullable()->index();       // owning console user
            $table->foreignId('device_group_id')->nullable()->index();
            // Presence (heartbeat-derived)
            $table->timestamp('last_online_at')->nullable()->index();
            $table->string('last_online_ip', 45)->nullable();
            $table->softDeletes(); // recycle bin
            $table->timestamps();
        });

        // Bearer tokens issued to RustDesk clients via /api/login
        Schema::create('client_tokens', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->index();
            $table->string('token', 64)->unique();
            $table->string('device_id')->nullable();   // rustdesk id of the logging-in client
            $table->string('device_uuid')->nullable();
            $table->string('device_os')->nullable();
            $table->string('device_name')->nullable();
            $table->string('client_type', 32)->nullable(); // mobile / desktop / web
            $table->timestamp('expires_at')->nullable();
            $table->timestamp('last_used_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('client_tokens');
        Schema::dropIfExists('devices');
        Schema::dropIfExists('device_groups');
        Schema::dropIfExists('user_groups');
    }
};
