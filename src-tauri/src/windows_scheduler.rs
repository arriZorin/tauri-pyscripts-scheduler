//! Native Windows Task Scheduler operations via the COM Task Scheduler API.
//!
//! These replace `schtasks.exe` spawning for the hot UI operations (create,
//! delete, run, enable/disable). The COM calls are fast in-process operations,
//! avoiding the several-second console-process startup latency that the
//! release-mode GUI process experienced with `schtasks.exe`.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use winapi::ctypes::c_void;
use winapi::shared::winerror::RPC_E_CHANGED_MODE;
use winapi::shared::wtypes::{BSTR, DATE, VT_I4};
use winapi::um::combaseapi::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL};
use winapi::um::oaidl::VARIANT;
use winapi::um::objbase::COINIT_APARTMENTTHREADED;
use winapi::um::oleauto::{SysFreeString, SysStringLen, VariantInit};
use winapi::um::taskschd::{
    IAction, IActionCollection, IDailyTrigger, IExecAction, IMonthlyTrigger, IRegisteredTask,
    IRegisteredTaskCollection, IRegistrationInfo, IRepetitionPattern, ITaskDefinition, ITaskFolder,
    ITaskService, ITaskSettings, ITrigger, ITriggerCollection, IWeeklyTrigger, TaskScheduler,
    TASK_ACTION_EXEC, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN, TASK_STATE_DISABLED,
    TASK_STATE_QUEUED, TASK_STATE_READY, TASK_STATE_RUNNING, TASK_STATE_UNKNOWN,
    TASK_TRIGGER_DAILY, TASK_TRIGGER_MONTHLY, TASK_TRIGGER_TIME, TASK_TRIGGER_WEEKLY,
};
use winapi::um::winnt::LONG;
use winapi::{Class, Interface};

use crate::scheduler::ScheduleSpec;

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// A task specification for native creation, mirroring the schtasks-based
/// `scheduler::CreateScheduledTask` payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateTaskSpec {
    pub task_name: String,
    pub venv_python_path: String,
    pub script_path: String,
    pub arguments: Vec<String>,
    pub working_directory: String,
    pub log_directory: String,
    pub schedule: ScheduleSpec,
}

/// Maps a task name (e.g. `PyscriptScheduler\\<id>`) to a log file stem by
/// replacing path separators, so the per-task log files are safe filenames.
pub fn log_file_stem(task_name: &str) -> String {
    task_name.replace('\\', "-").replace('/', "-")
}

/// Returns the app-data-relative stdout/stderr log paths for a task. The
/// frontend reads logs via `read_text_file`, which only accepts paths
/// relative to the app data directory, so the payload uses `logs/...`
/// instead of the absolute log directory.
pub fn relative_log_paths(log_directory: &str, task_name: &str) -> (String, String) {
    let dir_name = std::path::Path::new(log_directory)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let stem = log_file_stem(task_name);
    (
        format!("{}\\{}.out.log", dir_name, stem),
        format!("{}\\{}.err.log", dir_name, stem),
    )
}

/// Converts an OLE Automation DATE (days since 1899-12-30) to Unix seconds.
pub fn ole_date_to_unix_seconds(date: f64) -> i64 {
    ((date - 25569.0) * 86400.0).round() as i64
}

/// Validates that a value is an absolute Windows path with safe characters.
fn validate_absolute_path(value: &str, label: &str) -> Result<(), String> {
    validate_text(value, label)?;
    let bytes = value.as_bytes();
    if !(bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')) {
        return Err(format!("{} must be absolute", label));
    }
    Ok(())
}

/// Builds the exec action (program path, arguments) that runs the script
/// through `cmd.exe /c` and redirects stdout/stderr into per-task log files
/// inside the log directory. Pure so it is unit-testable without COM.
///
/// The arguments follow the `cmd /c ""...""` quoting convention: the whole
/// command is wrapped in one pair of quotes, and each path/argument is
/// individually quoted. Because `validate_text` rejects shell metacharacters
/// in all inputs, the embedded values cannot break out of the wrapper.
pub fn exec_action_parts(
    venv_python_path: &str,
    script_path: &str,
    arguments: &[String],
    log_directory: &str,
    task_name: &str,
) -> Result<(String, String), String> {
    validate_absolute_path(venv_python_path, "venv_python_path")?;
    validate_absolute_path(script_path, "script_path")?;
    validate_absolute_path(log_directory, "log_directory")?;
    for argument in arguments {
        validate_text(argument, "argument")?;
    }
    let stem = log_file_stem(task_name);
    let stdout_log = format!("{}\\{}.out.log", log_directory, stem);
    let stderr_log = format!("{}\\{}.err.log", log_directory, stem);

    let mut command = format!("\"{}\" \"{}\"", venv_python_path, script_path);
    for argument in arguments {
        command.push_str(&format!(" \"{}\"", argument));
    }
    command.push_str(&format!(" 1> \"{}\" 2> \"{}\"", stdout_log, stderr_log));

    Ok((
        "C:\\Windows\\System32\\cmd.exe".to_string(),
        format!("/c \"{}\"", command),
    ))
}

fn validate_text(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{} cannot be empty", label));
    }
    if value
        .chars()
        .any(|ch| matches!(ch, '&' | '|' | '<' | '>' | '^' | '%' | '"'))
    {
        return Err(format!("{} contains unsafe characters", label));
    }
    Ok(())
}

/// Repetition interval in ISO 8601 duration for a repetition trigger.
/// Returns `PT#M`/`PT#H`/`P#D`/`P#W`/`P#M` or an error for invalid intervals.
pub fn repetition_interval_iso(every: u32, unit: &str) -> Result<String, String> {
    if every == 0 {
        return Err("invalid interval".to_string());
    }
    match unit {
        "minutes" => Ok(format!("PT{every}M")),
        "hours" => Ok(format!("PT{every}H")),
        "days" => Ok(format!("P{every}D")),
        "weeks" => Ok(format!("P{every}W")),
        "months" => Ok(format!("P{every}M")),
        _ => Err("invalid interval".to_string()),
    }
}

/// Validates a `YYYY-MM-DDTHH:mm:00` start datetime.
pub fn validate_datetime(value: &str) -> Result<(), String> {
    validate_text(value, "start_at")?;
    let parts: Vec<&str> = value.split('T').collect();
    if parts.len() != 2 {
        return Err("start_at must use YYYY-MM-DDTHH:mm:00".to_string());
    }
    let date = parts[0];
    let time = parts[1];
    let date_parts: Vec<&str> = date.split('-').collect();
    if date_parts.len() != 3 {
        return Err("start_at must use YYYY-MM-DDTHH:mm:00".to_string());
    }
    let year = date_parts[0]
        .parse::<u32>()
        .map_err(|_| "start_at must use YYYY-MM-DDTHH:mm:00".to_string())?;
    let month = date_parts[1]
        .parse::<u32>()
        .map_err(|_| "start_at must use YYYY-MM-DDTHH:mm:00".to_string())?;
    let day = date_parts[2]
        .parse::<u32>()
        .map_err(|_| "start_at must use YYYY-MM-DDTHH:mm:00".to_string())?;
    if !(1..=12).contains(&month) {
        return Err("start_at must use YYYY-MM-DDTHH:mm:00".to_string());
    }
    let days_in_month = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > days_in_month {
        return Err("start_at must use YYYY-MM-DDTHH:mm:00".to_string());
    }
    let time_parts: Vec<&str> = time.split(':').collect();
    if time_parts.len() != 3 || time_parts[2] != "00" {
        return Err("start_at must use YYYY-MM-DDTHH:mm:00".to_string());
    }
    let hour = time_parts[0]
        .parse::<u32>()
        .map_err(|_| "start_at must use YYYY-MM-DDTHH:mm:00".to_string())?;
    let minute = time_parts[1]
        .parse::<u32>()
        .map_err(|_| "start_at must use YYYY-MM-DDTHH:mm:00".to_string())?;
    if hour > 23 || minute > 59 || time_parts[0].len() != 2 || time_parts[1].len() != 2 {
        return Err("start_at must use YYYY-MM-DDTHH:mm:00".to_string());
    }
    Ok(())
}

/// Describes exactly which Windows trigger to build for a schedule.
///
/// Kept pure so it is unit-testable without COM. Only one family of fields
/// is populated per plan; the rest keep their defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerPlan {
    /// Base trigger type (`TASK_TRIGGER_*`).
    pub trigger_type: u32,
    /// ISO `YYYY-MM-DDTHH:mm:00` start boundary.
    pub start_boundary: String,
    /// Repetition interval ISO (`PT#M`/`PT#H`), only for minute/hour units.
    pub repetition_iso: Option<String>,
    /// Native `DaysInterval` for a Daily trigger (1 = every day).
    pub days_interval: u32,
    /// Native `WeeksInterval` for a Weekly trigger (1 = every week).
    pub weeks_interval: u32,
    /// `DaysOfWeek` bitmask for a Weekly trigger (bit 0 = Sunday).
    pub day_of_week: Option<i16>,
    /// `MonthsOfYear` bitmask for a Monthly trigger (bit 0 = January).
    pub months_of_year: Option<i16>,
    /// `DaysOfMonth` bitmask for a Monthly trigger (bit 0 = 1st).
    pub day_of_month: Option<i32>,
}

impl Default for TriggerPlan {
    fn default() -> Self {
        TriggerPlan {
            trigger_type: TASK_TRIGGER_TIME,
            start_boundary: String::new(),
            repetition_iso: None,
            days_interval: 0,
            weeks_interval: 0,
            day_of_week: None,
            months_of_year: None,
            day_of_month: None,
        }
    }
}

/// Parses `YYYY-MM-DD` (the date part of a validated start_at) into y/m/d.
fn parse_ymd(date: &str) -> Result<(i64, i64, i64), String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err("invalid date".to_string());
    }
    let y = parts[0].parse::<i64>().map_err(|_| "invalid date")?;
    let m = parts[1].parse::<i64>().map_err(|_| "invalid date")?;
    let d = parts[2].parse::<i64>().map_err(|_| "invalid date")?;
    Ok((y, m, d))
}

/// Days since 1970-01-01 (proleptic Gregorian, Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // Mar=0, ..., Feb=11
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Weekday (0=Sunday .. 6=Saturday) for a `YYYY-MM-DD` date string.
fn weekday_from_ymd(date: &str) -> Result<i64, String> {
    let (y, m, d) = parse_ymd(date)?;
    // 1970-01-01 was a Thursday (4, 0=Sunday).
    Ok((days_from_civil(y, m, d) + 4).rem_euclid(7))
}

/// Builds the trigger plan for a schedule: minute/hour -> Daily base with a
/// repetition pattern; day/week/month -> native trigger interval without
/// repetition. Replaces the buggy mapping that used an invalid repetition
/// trigger type for every interval unit.
pub fn trigger_plan(schedule: &ScheduleSpec) -> Result<TriggerPlan, String> {
    Ok(match schedule {
        ScheduleSpec::Once { run_at } => {
            validate_text(run_at, "run_at")?;
            TriggerPlan {
                trigger_type: TASK_TRIGGER_TIME,
                start_boundary: run_at.clone(),
                ..Default::default()
            }
        }
        ScheduleSpec::Daily { start_at } => {
            validate_datetime(start_at)?;
            TriggerPlan {
                trigger_type: TASK_TRIGGER_DAILY,
                start_boundary: start_at.clone(),
                days_interval: 1,
                ..Default::default()
            }
        }
        ScheduleSpec::Weekly {
            start_at,
            day_of_week,
        } => {
            validate_datetime(start_at)?;
            if *day_of_week > 6 {
                return Err("day_of_week must be between 0 and 6".to_string());
            }
            TriggerPlan {
                trigger_type: TASK_TRIGGER_WEEKLY,
                start_boundary: start_at.clone(),
                weeks_interval: 1,
                day_of_week: Some(1 << *day_of_week as i16),
                ..Default::default()
            }
        }
        ScheduleSpec::Interval {
            start_at,
            every,
            unit,
        } => {
            validate_datetime(start_at)?;
            if *every == 0 {
                return Err("invalid interval".to_string());
            }
            let date = start_at.split('T').next().unwrap_or_default();
            match unit.as_str() {
                // Minute/hour intervals: Windows has no native "every X
                // minutes/hours" trigger, so we build a Daily trigger (every
                // day) plus a repetition pattern of the interval, repeated
                // indefinitely (empty Duration). This is the documented
                // pattern for sub-daily recurrence.
                "minutes" | "hours" => TriggerPlan {
                    trigger_type: TASK_TRIGGER_DAILY,
                    start_boundary: start_at.clone(),
                    repetition_iso: Some(repetition_interval_iso(*every, unit)?),
                    days_interval: 1,
                    ..Default::default()
                },
                "days" => TriggerPlan {
                    trigger_type: TASK_TRIGGER_DAILY,
                    start_boundary: start_at.clone(),
                    days_interval: *every,
                    ..Default::default()
                },
                "weeks" => TriggerPlan {
                    trigger_type: TASK_TRIGGER_WEEKLY,
                    start_boundary: start_at.clone(),
                    weeks_interval: *every,
                    // Every N weeks needs a day of week; default to the
                    // weekday of the start date.
                    day_of_week: Some((1 << weekday_from_ymd(date)?) as i16),
                    ..Default::default()
                },
                "months" => {
                    // winapi has no `MonthsInterval` property, so "every N
                    // months" is expressed by selecting every month aligned
                    // to the start month modulo N, wrapping through the year.
                    let (_, start_month, start_day) = parse_ymd(date)?;
                    let start_index = (start_month - 1) % *every as i64;
                    let mut months: i16 = 0;
                    for m in 0..12 {
                        if m % *every as i64 == start_index {
                            months |= 1 << m as i16;
                        }
                    }
                    TriggerPlan {
                        trigger_type: TASK_TRIGGER_MONTHLY,
                        start_boundary: start_at.clone(),
                        months_of_year: Some(months),
                        day_of_month: Some((1 << (start_day - 1)) as i32),
                        ..Default::default()
                    }
                }
                _ => return Err("invalid interval".to_string()),
            }
        }
    })
}

/// Trigger type plus start-boundary/interval ISO strings for a schedule.
/// Kept pure so it is unit-testable without COM.
#[cfg(test)]
pub fn schedule_trigger_parts(schedule: &ScheduleSpec) -> Result<(u32, String, String), String> {
    match schedule {
        ScheduleSpec::Once { run_at } => {
            validate_text(run_at, "run_at")?;
            Ok((TASK_TRIGGER_TIME, run_at.clone(), String::new()))
        }
        ScheduleSpec::Daily { start_at } => {
            validate_datetime(start_at)?;
            Ok((TASK_TRIGGER_DAILY, start_at.clone(), String::new()))
        }
        ScheduleSpec::Weekly {
            start_at,
            day_of_week,
        } => {
            validate_datetime(start_at)?;
            if *day_of_week > 6 {
                return Err("day_of_week must be between 0 and 6".to_string());
            }
            Ok((TASK_TRIGGER_WEEKLY, start_at.clone(), String::new()))
        }
        ScheduleSpec::Interval {
            start_at,
            every: _,
            unit: _,
        } => {
            validate_datetime(start_at)?;
            let plan = trigger_plan(schedule)?;
            Ok((
                plan.trigger_type,
                start_at.clone(),
                plan.repetition_iso.unwrap_or_default(),
            ))
        }
    }
}

macro_rules! check_hr {
    ($hr:expr, $message:expr) => {
        if $hr < 0 {
            return Err(format!("{}: 0x{:08x}", $message, $hr));
        }
    };
}

struct ComGuard(bool);

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() }
        }
    }
}

/// Connects to the local Task Scheduler service, owning the COM initialization.
struct TaskConnection {
    service: *mut ITaskService,
    _com: ComGuard,
}

impl Drop for TaskConnection {
    fn drop(&mut self) {
        unsafe { (*self.service).Release() };
    }
}

fn connect() -> Result<TaskConnection, String> {
    let init = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED) };
    if init < 0 && init != RPC_E_CHANGED_MODE {
        return Err(format!(
            "failed to initialize Task Scheduler COM: 0x{init:08x}"
        ));
    }
    let com = ComGuard(init >= 0);

    let mut service: *mut ITaskService = ptr::null_mut();
    let hr = unsafe {
        CoCreateInstance(
            &TaskScheduler::uuidof(),
            ptr::null_mut(),
            CLSCTX_ALL,
            &ITaskService::uuidof(),
            &mut service as *mut _ as *mut *mut c_void,
        )
    };
    check_hr!(hr, "failed to create Task Scheduler service");

    let empty: VARIANT = unsafe { std::mem::zeroed() };
    let hr = unsafe { (*service).Connect(empty, empty, empty, empty) };
    if hr < 0 {
        unsafe { (*service).Release() };
        return Err(format!("failed to connect to Task Scheduler: 0x{hr:08x}"));
    }

    Ok(TaskConnection { service, _com: com })
}

fn root_folder(connection: &TaskConnection) -> Result<*mut ITaskFolder, String> {
    let root_path = wide("\\");
    let mut folder: *mut ITaskFolder = ptr::null_mut();
    let hr =
        unsafe { (*connection.service).GetFolder(root_path.as_ptr() as *mut u16, &mut folder) };
    check_hr!(hr, "failed to open Task Scheduler root");
    Ok(folder)
}

fn set_start_boundary(trigger: *mut ITrigger, boundary: &str) -> Result<(), String> {
    let boundary_wide = wide(boundary);
    let hr = unsafe { (*trigger).put_StartBoundary(boundary_wide.as_ptr() as *mut u16) };
    check_hr!(hr, "failed to set trigger start boundary");
    Ok(())
}

unsafe fn build_trigger(
    task: *mut ITaskDefinition,
    schedule: &ScheduleSpec,
) -> Result<*mut ITrigger, String> {
    let plan = trigger_plan(schedule)?;
    let (trigger_type, boundary) = (plan.trigger_type, plan.start_boundary.clone());

    let mut triggers: *mut ITriggerCollection = ptr::null_mut();
    let hr = (*task).get_Triggers(&mut triggers);
    check_hr!(hr, "failed to get trigger collection");
    let triggers = triggers;

    let mut trigger: *mut ITrigger = ptr::null_mut();
    let hr = (*triggers).Create(trigger_type, &mut trigger);
    (*triggers).Release();
    check_hr!(hr, "failed to create trigger");
    let trigger = trigger;

    if let Err(e) = set_start_boundary(trigger, &boundary) {
        (*trigger).Release();
        return Err(e);
    }

    // Minute/hour intervals repeat via a repetition pattern on a Daily base
    // trigger. An empty Duration repeats the pattern indefinitely; the old
    // code set `PT0S` (zero duration), which silently disabled repetition.
    if let Some(interval) = &plan.repetition_iso {
        let interval_wide = wide(interval);
        let duration_wide = wide("");
        let mut repetition: *mut IRepetitionPattern = ptr::null_mut();
        let hr = unsafe { (*trigger).get_Repetition(&mut repetition) };
        if hr < 0 {
            (*trigger).Release();
            return Err(format!("failed to get repetition pattern: 0x{hr:08x}"));
        }
        let hr = unsafe { (*repetition).put_Interval(interval_wide.as_ptr() as *mut u16) };
        if hr < 0 {
            (*repetition).Release();
            (*trigger).Release();
            return Err(format!("failed to set repetition interval: 0x{hr:08x}"));
        }
        let hr = unsafe { (*repetition).put_Duration(duration_wide.as_ptr() as *mut u16) };
        unsafe { (*repetition).Release() };
        if hr < 0 {
            (*trigger).Release();
            return Err(format!("failed to set repetition duration: 0x{hr:08x}"));
        }
    }

    if let Err(e) = set_trigger_specifics(trigger, &plan) {
        (*trigger).Release();
        return Err(e);
    }

    Ok(trigger)
}

unsafe fn set_trigger_specifics(trigger: *mut ITrigger, plan: &TriggerPlan) -> Result<(), String> {
    match plan.trigger_type {
        TASK_TRIGGER_DAILY => {
            let mut daily: *mut IDailyTrigger = ptr::null_mut();
            let hr = (*trigger).QueryInterface(
                &IDailyTrigger::uuidof(),
                &mut daily as *mut _ as *mut *mut c_void,
            );
            check_hr!(hr, "failed to query daily trigger");
            // plan.days_interval is 1 for plain daily and minute/hour bases,
            // or `every` for a day-interval schedule.
            let hr = (*daily).put_DaysInterval(plan.days_interval as i16);
            (*daily).Release();
            check_hr!(hr, "failed to set daily interval");
        }
        TASK_TRIGGER_WEEKLY => {
            let mut weekly: *mut IWeeklyTrigger = ptr::null_mut();
            let hr = (*trigger).QueryInterface(
                &IWeeklyTrigger::uuidof(),
                &mut weekly as *mut _ as *mut *mut c_void,
            );
            check_hr!(hr, "failed to query weekly trigger");
            let day_bit = plan.day_of_week.unwrap_or(1 << 0);
            let hr = (*weekly).put_DaysOfWeek(day_bit);
            if hr < 0 {
                (*weekly).Release();
                return Err(format!("failed to set weekly days: 0x{hr:08x}"));
            }
            let hr = (*weekly).put_WeeksInterval(plan.weeks_interval as i16);
            (*weekly).Release();
            check_hr!(hr, "failed to set weekly interval");
        }
        TASK_TRIGGER_MONTHLY => {
            let mut monthly: *mut IMonthlyTrigger = ptr::null_mut();
            let hr = (*trigger).QueryInterface(
                &IMonthlyTrigger::uuidof(),
                &mut monthly as *mut _ as *mut *mut c_void,
            );
            check_hr!(hr, "failed to query monthly trigger");
            if let Some(months) = plan.months_of_year {
                let hr = (*monthly).put_MonthsOfYear(months);
                if hr < 0 {
                    (*monthly).Release();
                    return Err(format!("failed to set months of year: 0x{hr:08x}"));
                }
            }
            if let Some(day) = plan.day_of_month {
                let hr = (*monthly).put_DaysOfMonth(day);
                if hr < 0 {
                    (*monthly).Release();
                    return Err(format!("failed to set days of month: 0x{hr:08x}"));
                }
            }
            (*monthly).Release();
        }
        _ => {}
    }
    Ok(())
}

/// Creates (or updates) a scheduled task using the native Task Scheduler API.
pub fn create_task(spec: &CreateTaskSpec) -> Result<String, String> {
    validate_text(&spec.task_name, "task_name")?;
    validate_text(&spec.venv_python_path, "venv_python_path")?;
    validate_text(&spec.script_path, "script_path")?;
    validate_text(&spec.working_directory, "working_directory")?;
    for argument in &spec.arguments {
        validate_text(argument, "argument")?;
    }
    // Build the cmd.exe action up front (pure): stdout/stderr are redirected
    // into per-task log files inside the log directory.
    let (action_path, action_arguments) = exec_action_parts(
        &spec.venv_python_path,
        &spec.script_path,
        &spec.arguments,
        &spec.log_directory,
        &spec.task_name,
    )?;

    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let mut task: *mut ITaskDefinition = ptr::null_mut();
    let hr = unsafe { (*connection.service).NewTask(0, &mut task) };
    if hr < 0 {
        unsafe { (*folder).Release() };
        return Err(format!("failed to create task definition: 0x{hr:08x}"));
    }

    // Registration info (author).
    let mut registration: *mut IRegistrationInfo = ptr::null_mut();
    let hr = unsafe { (*task).get_RegistrationInfo(&mut registration) };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to get registration info: 0x{hr:08x}"));
    }
    let author = wide("PyscriptScheduler");
    let hr = unsafe { (*registration).put_Author(author.as_ptr() as *mut u16) };
    unsafe { (*registration).Release() };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to set task author: 0x{hr:08x}"));
    }

    // Settings: start when available, and run on battery power. The COM
    // Task Scheduler defaults to DisallowStartIfOnBatteries=true, which
    // silently keeps tasks queued forever on laptops running on battery —
    // a scheduled-script manager must run its scripts regardless of power
    // source (verified empirically: task stayed Queued, LastResult 0, no
    // execution on a discharging battery).
    let mut settings: *mut ITaskSettings = ptr::null_mut();
    let hr = unsafe { (*task).get_Settings(&mut settings) };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to get task settings: 0x{hr:08x}"));
    }
    let hr = unsafe { (*settings).put_StartWhenAvailable(-1i16) };
    if hr < 0 {
        unsafe { (*settings).Release() };
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to set task settings: 0x{hr:08x}"));
    }
    let hr = unsafe { (*settings).put_DisallowStartIfOnBatteries(0i16) };
    if hr < 0 {
        unsafe { (*settings).Release() };
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to allow battery start: 0x{hr:08x}"));
    }
    let hr = unsafe { (*settings).put_StopIfGoingOnBatteries(0i16) };
    unsafe { (*settings).Release() };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to allow battery continuation: 0x{hr:08x}"));
    }

    // Trigger.
    let trigger = unsafe { build_trigger(task, &spec.schedule) }?;
    unsafe { (*trigger).Release() };

    // Action: run the interpreter through cmd.exe (parts built above).
    let mut actions: *mut IActionCollection = ptr::null_mut();
    let hr = unsafe { (*task).get_Actions(&mut actions) };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to get action collection: 0x{hr:08x}"));
    }
    let mut action: *mut IAction = ptr::null_mut();
    let hr = unsafe { (*actions).Create(TASK_ACTION_EXEC, &mut action) };
    unsafe { (*actions).Release() };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to create action: 0x{hr:08x}"));
    }

    let mut exec: *mut IExecAction = ptr::null_mut();
    let hr = unsafe {
        (*action).QueryInterface(
            &IExecAction::uuidof(),
            &mut exec as *mut _ as *mut *mut c_void,
        )
    };
    unsafe { (*action).Release() };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to query exec action: 0x{hr:08x}"));
    }

    let path_wide = wide(&action_path);
    let hr = unsafe { (*exec).put_Path(path_wide.as_ptr() as *mut u16) };
    if hr < 0 {
        unsafe { (*exec).Release() };
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to set action path: 0x{hr:08x}"));
    }

    let arguments_wide = wide(&action_arguments);
    let hr = unsafe { (*exec).put_Arguments(arguments_wide.as_ptr() as *mut u16) };
    if hr < 0 {
        unsafe { (*exec).Release() };
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to set action arguments: 0x{hr:08x}"));
    }

    let working_wide = wide(&spec.working_directory);
    let hr = unsafe { (*exec).put_WorkingDirectory(working_wide.as_ptr() as *mut u16) };
    unsafe { (*exec).Release() };
    if hr < 0 {
        unsafe { (*task).Release() };
        unsafe { (*folder).Release() };
        return Err(format!("failed to set working directory: 0x{hr:08x}"));
    }

    // Register as the current user (interactive token, no elevation).
    let task_name_wide = wide(&spec.task_name);
    let mut empty: VARIANT = unsafe { std::mem::zeroed() };
    unsafe { VariantInit(&mut empty) };
    let mut registered: *mut IRegisteredTask = ptr::null_mut();
    let hr = unsafe {
        (*folder).RegisterTaskDefinition(
            task_name_wide.as_ptr() as *mut u16,
            task,
            TASK_CREATE_OR_UPDATE as i32,
            empty,
            empty,
            TASK_LOGON_INTERACTIVE_TOKEN,
            empty,
            &mut registered,
        )
    };
    unsafe { (*task).Release() };
    unsafe { (*folder).Release() };
    check_hr!(hr, "failed to register task");
    unsafe { (*registered).Release() };

    Ok(format!("registered {}", spec.task_name))
}

/// Deletes a scheduled task. A missing task is reported as an error (the
/// frontend treats delete-of-missing as success semantics at its layer).
pub fn delete_task(task_name: &str) -> Result<String, String> {
    validate_text(task_name, "task_name")?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let task_name_wide = wide(task_name);
    let hr = unsafe { (*folder).DeleteTask(task_name_wide.as_ptr() as *mut u16, 0) };
    unsafe { (*folder).Release() };
    check_hr!(
        hr,
        format!("failed to delete scheduled task '{}'", task_name)
    );

    Ok(format!("deleted {}", task_name))
}

/// Runs a scheduled task immediately (Run Now) without changing its schedule.
pub fn run_task(task_name: &str) -> Result<String, String> {
    validate_text(task_name, "task_name")?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let task_name_wide = wide(task_name);
    let mut registered: *mut IRegisteredTask = ptr::null_mut();
    let hr = unsafe { (*folder).GetTask(task_name_wide.as_ptr() as *mut u16, &mut registered) };
    unsafe { (*folder).Release() };
    check_hr!(hr, format!("failed to open scheduled task '{}'", task_name));

    let empty: VARIANT = unsafe { std::mem::zeroed() };
    let hr = unsafe { (*registered).Run(empty, ptr::null_mut()) };
    unsafe { (*registered).Release() };
    check_hr!(hr, format!("failed to run scheduled task '{}'", task_name));

    Ok(format!("started {}", task_name))
}

/// Keeps only task names under the app's `PyscriptScheduler\` namespace.
/// COM returns full paths (possibly with a leading `\`), or bare task names
/// when enumerating the `PyscriptScheduler` subfolder directly; both are
/// normalized to `PyscriptScheduler\<name>`. Pure so it is unit-testable.
pub fn managed_task_names(names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .map(|name| name.trim_start_matches('\\').to_string())
        .map(|name| {
            if name.starts_with("PyscriptScheduler\\") {
                name
            } else if !name.contains('\\') {
                // Bare name from enumerating the PyscriptScheduler subfolder.
                format!("PyscriptScheduler\\{}", name)
            } else {
                // Foreign path (other namespace) — dropped by the filter.
                name
            }
        })
        .filter(|name| name.starts_with("PyscriptScheduler\\"))
        .collect()
}

/// Lists the names of all registered tasks in the app's namespace through
/// the native Task Scheduler API. Used by the frontend to reconcile JSON
/// tasks with their Windows registrations.
///
/// Tasks are registered as `PyscriptScheduler\<id>`, and Task Scheduler
/// treats the backslash as a folder separator — they live in the
/// `PyscriptScheduler` subfolder, NOT the root. Enumerating the root
/// (`GetTasks` on `\`) finds nothing, which made every task look missing.
/// The subfolder is enumerated instead, and `get_Path` (full path) is read
/// so names come back namespace-qualified.
pub fn list_scheduled_tasks() -> Result<Vec<String>, String> {
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    // Open the app's subfolder; a missing folder means no managed tasks.
    let managed_path = wide("\\PyscriptScheduler");
    let mut managed_folder: *mut ITaskFolder = ptr::null_mut();
    let hr = unsafe { (*folder).GetFolder(managed_path.as_ptr() as *mut u16, &mut managed_folder) };
    unsafe { (*folder).Release() };
    if hr < 0 {
        return Ok(Vec::new());
    }

    let mut collection: *mut IRegisteredTaskCollection = ptr::null_mut();
    let hr = unsafe { (*managed_folder).GetTasks(0, &mut collection) };
    unsafe { (*managed_folder).Release() };
    check_hr!(hr, "failed to enumerate scheduled tasks");

    let mut count: LONG = 0;
    let hr = unsafe { (*collection).get_Count(&mut count) };
    if hr < 0 {
        unsafe { (*collection).Release() };
        return Err(format!("failed to count scheduled tasks: 0x{hr:08x}"));
    }

    let mut names = Vec::new();
    for index in 1..=count {
        let mut item: VARIANT = unsafe { std::mem::zeroed() };
        unsafe {
            item.n1.n2_mut().vt = VT_I4 as u16;
            *item.n1.n2_mut().n3.lVal_mut() = index;
        }

        let mut registered: *mut IRegisteredTask = ptr::null_mut();
        let hr = unsafe { (*collection).get_Item(item, &mut registered) };
        if hr < 0 {
            continue;
        }
        let mut name: BSTR = ptr::null_mut();
        let hr = unsafe { (*registered).get_Path(&mut name) };
        unsafe { (*registered).Release() };
        if hr >= 0 && !name.is_null() {
            names.push(bstr_to_string(name));
        }
    }
    unsafe { (*collection).Release() };

    Ok(managed_task_names(names))
}

fn bstr_to_string(value: BSTR) -> String {
    unsafe {
        let len = SysStringLen(value) as usize;
        let slice = std::slice::from_raw_parts(value, len);
        let text = String::from_utf16_lossy(slice);
        SysFreeString(value);
        text
    }
}

/// Maps a `TASK_STATE` value to its stable name. Pure so it is unit-testable.
pub fn task_state_name(state: u32) -> &'static str {
    match state {
        TASK_STATE_DISABLED => "disabled",
        TASK_STATE_QUEUED => "queued",
        TASK_STATE_READY => "ready",
        TASK_STATE_RUNNING => "running",
        _ => "unknown",
    }
}

/// Queries the current state of a scheduled task through the native API.
pub fn task_status(task_name: &str) -> Result<String, String> {
    validate_text(task_name, "task_name")?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let task_name_wide = wide(task_name);
    let mut registered: *mut IRegisteredTask = ptr::null_mut();
    let hr = unsafe { (*folder).GetTask(task_name_wide.as_ptr() as *mut u16, &mut registered) };
    unsafe { (*folder).Release() };
    check_hr!(hr, format!("failed to open scheduled task '{}'", task_name));

    let mut state: u32 = TASK_STATE_UNKNOWN;
    let hr = unsafe { (*registered).get_State(&mut state) };
    unsafe { (*registered).Release() };
    check_hr!(hr, format!("failed to query state of '{}'", task_name));

    Ok(task_state_name(state).to_string())
}

/// Result payload for the last execution of a scheduled task.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TaskRunResult {
    /// Unix seconds of the last run, when the task has run at least once.
    pub last_run_at: Option<i64>,
    /// Exit code (HRESULT/LONG) of the last run, when available.
    pub last_result: Option<i32>,
    /// App-data-relative path of the stdout log file for this task.
    pub stdout_log: String,
    /// App-data-relative path of the stderr log file for this task.
    pub stderr_log: String,
}

/// Queries the last execution info (run time + exit code) of a task plus its
/// per-task log file paths through the native API.
pub fn task_run_result(task_name: &str, log_directory: &str) -> Result<TaskRunResult, String> {
    validate_text(task_name, "task_name")?;
    validate_absolute_path(log_directory, "log_directory")?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let task_name_wide = wide(task_name);
    let mut registered: *mut IRegisteredTask = ptr::null_mut();
    let hr = unsafe { (*folder).GetTask(task_name_wide.as_ptr() as *mut u16, &mut registered) };
    unsafe { (*folder).Release() };
    check_hr!(hr, format!("failed to open scheduled task '{}'", task_name));

    let mut last_run: DATE = 0.0;
    let hr = unsafe { (*registered).get_LastRunTime(&mut last_run) };
    let mut last_result: LONG = 0;
    let hr_result = unsafe { (*registered).get_LastTaskResult(&mut last_result) };
    unsafe { (*registered).Release() };
    check_hr!(
        hr,
        format!("failed to query last run time of '{}'", task_name)
    );
    check_hr!(
        hr_result,
        format!("failed to query last result of '{}'", task_name)
    );

    let (stdout_log, stderr_log) = relative_log_paths(log_directory, task_name);
    Ok(TaskRunResult {
        last_run_at: (last_run > 0.0).then(|| ole_date_to_unix_seconds(last_run)),
        last_result: Some(last_result),
        stdout_log,
        stderr_log,
    })
}

/// Enables or disables a scheduled task.
pub fn set_enabled(task_name: &str, enabled: bool) -> Result<String, String> {
    validate_text(task_name, "task_name")?;
    let connection = connect()?;
    let folder = root_folder(&connection)?;

    let task_name_wide = wide(task_name);
    let mut registered: *mut IRegisteredTask = ptr::null_mut();
    let hr = unsafe { (*folder).GetTask(task_name_wide.as_ptr() as *mut u16, &mut registered) };
    unsafe { (*folder).Release() };
    check_hr!(hr, format!("failed to open scheduled task '{}'", task_name));

    let hr = unsafe { (*registered).put_Enabled(if enabled { -1i16 } else { 0i16 }) };
    unsafe { (*registered).Release() };
    check_hr!(
        hr,
        format!("failed to toggle scheduled task '{}'", task_name)
    );

    Ok(if enabled { "enabled" } else { "disabled" }.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_unsafe_task_names() {
        assert!(validate_text("", "task_name").is_err());
        assert!(validate_text("task&name", "task_name").is_err());
        assert!(validate_text("task|name", "task_name").is_err());
        assert!(validate_text("PyscriptScheduler\\bill", "task_name").is_ok());
    }

    #[test]
    fn log_file_stem_replaces_separators() {
        assert_eq!(
            log_file_stem("PyscriptScheduler\\task-1"),
            "PyscriptScheduler-task-1"
        );
        assert_eq!(log_file_stem("task.1"), "task.1");
    }

    #[test]
    fn ole_date_epoch_is_1899_12_30() {
        // OLE DATE 25569.0 == 1970-01-01T00:00:00Z (days from 1899-12-30).
        assert_eq!(ole_date_to_unix_seconds(25569.0), 0);
        // One day later.
        assert_eq!(ole_date_to_unix_seconds(25570.0), 86400);
        // 2026-08-14T00:00:00Z == 46248.0 OLE DATE.
        assert_eq!(ole_date_to_unix_seconds(46248.0), 1786665600);
    }

    #[test]
    fn exec_action_parts_redirects_stdout_and_stderr_into_log_dir() {
        let (path, args) = exec_action_parts(
            "C:\\Python312\\python.exe",
            "C:\\Scripts\\backup.py",
            &["--output".to_string(), "C:\\Backup Folder".to_string()],
            "C:\\AppData\\logs",
            "PyscriptScheduler\\task-1",
        )
        .unwrap();
        assert_eq!(path.to_lowercase(), "c:\\windows\\system32\\cmd.exe");
        assert!(args.contains("C:\\Python312\\python.exe"));
        assert!(args.contains("C:\\Scripts\\backup.py"));
        assert!(args.contains("C:\\Backup Folder"));
        assert!(args.contains("1>"));
        assert!(args.contains("2>"));
        assert!(args.contains("C:\\AppData\\logs\\PyscriptScheduler-task-1.out.log"));
        assert!(args.contains("C:\\AppData\\logs\\PyscriptScheduler-task-1.err.log"));
        assert!(args.starts_with("/c \"\""));
    }

    #[test]
    fn exec_action_parts_rejects_unsafe_arguments() {
        let result = exec_action_parts(
            "C:\\Python312\\python.exe",
            "C:\\Scripts\\backup.py",
            &["--output".to_string(), "a&b".to_string()],
            "C:\\AppData\\logs",
            "PyscriptScheduler\\task-1",
        );
        assert!(result.is_err());
    }

    #[test]
    fn run_result_log_paths_are_relative_to_app_data_dir() {
        // The frontend reads logs via read_text_file, which only accepts
        // paths relative to the app data directory, so the payload must
        // return relative paths (logs/...), not absolute ones.
        let (stdout_log, stderr_log) = relative_log_paths(
            "C:\\Users\\me\\AppData\\Roaming\\com.tauri-app\\logs",
            "PyscriptScheduler\\task-1",
        );
        assert_eq!(stdout_log, "logs\\PyscriptScheduler-task-1.out.log");
        assert_eq!(stderr_log, "logs\\PyscriptScheduler-task-1.err.log");
    }

    #[test]
    fn repetition_interval_converts_units_to_iso() {
        assert_eq!(repetition_interval_iso(5, "minutes").unwrap(), "PT5M");
        assert_eq!(repetition_interval_iso(2, "hours").unwrap(), "PT2H");
        assert_eq!(repetition_interval_iso(3, "days").unwrap(), "P3D");
        assert_eq!(repetition_interval_iso(2, "weeks").unwrap(), "P2W");
        assert_eq!(repetition_interval_iso(1, "months").unwrap(), "P1M");
        assert!(repetition_interval_iso(0, "minutes").is_err());
        assert!(repetition_interval_iso(1, "fortnights").is_err());
    }

    #[test]
    fn schedule_trigger_parts_map_all_families() {
        let (t, boundary, interval) = schedule_trigger_parts(&ScheduleSpec::Once {
            run_at: "2026-08-14T08:30:00".to_string(),
        })
        .unwrap();
        assert_eq!(t, TASK_TRIGGER_TIME);
        assert_eq!(boundary, "2026-08-14T08:30:00");
        assert!(interval.is_empty());

        let (t, boundary, interval) = schedule_trigger_parts(&ScheduleSpec::Daily {
            start_at: "2026-08-14T08:30:00".to_string(),
        })
        .unwrap();
        assert_eq!(t, TASK_TRIGGER_DAILY);
        assert_eq!(boundary, "2026-08-14T08:30:00");
        assert!(interval.is_empty());

        let (t, boundary, _) = schedule_trigger_parts(&ScheduleSpec::Weekly {
            start_at: "2026-08-14T08:30:00".to_string(),
            day_of_week: 6,
        })
        .unwrap();
        assert_eq!(t, TASK_TRIGGER_WEEKLY);
        assert_eq!(boundary, "2026-08-14T08:30:00");

        assert!(schedule_trigger_parts(&ScheduleSpec::Weekly {
            start_at: "2026-08-14T08:30:00".to_string(),
            day_of_week: 7,
        })
        .is_err());

        let (t, _, interval) = schedule_trigger_parts(&ScheduleSpec::Interval {
            start_at: "2026-08-14T08:30:00".to_string(),
            every: 30,
            unit: "minutes".to_string(),
        })
        .unwrap();
        assert_eq!(t, TASK_TRIGGER_DAILY);
        assert_eq!(interval, "PT30M");
    }

    #[test]
    fn interval_minutes_uses_daily_base_with_repetition() {
        let plan = trigger_plan(&ScheduleSpec::Interval {
            start_at: "2026-08-14T08:30:00".to_string(),
            every: 30,
            unit: "minutes".to_string(),
        })
        .unwrap();
        assert_eq!(plan.trigger_type, TASK_TRIGGER_DAILY);
        assert_eq!(plan.repetition_iso.as_deref(), Some("PT30M"));
        assert_eq!(plan.days_interval, 1);
    }

    #[test]
    fn interval_hours_uses_daily_base_with_repetition() {
        let plan = trigger_plan(&ScheduleSpec::Interval {
            start_at: "2026-08-14T08:30:00".to_string(),
            every: 2,
            unit: "hours".to_string(),
        })
        .unwrap();
        assert_eq!(plan.trigger_type, TASK_TRIGGER_DAILY);
        assert_eq!(plan.repetition_iso.as_deref(), Some("PT2H"));
        assert_eq!(plan.days_interval, 1);
    }

    #[test]
    fn interval_days_uses_native_daily_interval_without_repetition() {
        let plan = trigger_plan(&ScheduleSpec::Interval {
            start_at: "2026-08-14T08:30:00".to_string(),
            every: 3,
            unit: "days".to_string(),
        })
        .unwrap();
        assert_eq!(plan.trigger_type, TASK_TRIGGER_DAILY);
        assert!(plan.repetition_iso.is_none());
        assert_eq!(plan.days_interval, 3);
    }

    #[test]
    fn interval_weeks_uses_native_weekly_interval_without_repetition() {
        // 2026-08-14 is a Friday (0=Sunday).
        let plan = trigger_plan(&ScheduleSpec::Interval {
            start_at: "2026-08-14T08:30:00".to_string(),
            every: 2,
            unit: "weeks".to_string(),
        })
        .unwrap();
        assert_eq!(plan.trigger_type, TASK_TRIGGER_WEEKLY);
        assert!(plan.repetition_iso.is_none());
        assert_eq!(plan.weeks_interval, 2);
        assert_eq!(plan.day_of_week, Some(1 << 5)); // Friday
    }

    #[test]
    fn interval_months_uses_native_monthly_monthsofyear_without_repetition() {
        // Start 2026-08-14 -> every 3 months = Aug, Nov, Feb, May.
        let plan = trigger_plan(&ScheduleSpec::Interval {
            start_at: "2026-08-14T08:30:00".to_string(),
            every: 3,
            unit: "months".to_string(),
        })
        .unwrap();
        assert_eq!(plan.trigger_type, TASK_TRIGGER_MONTHLY);
        assert!(plan.repetition_iso.is_none());
        let months = plan.months_of_year.unwrap();
        // Bitmask: Aug=0x0080, Nov=0x0400, Feb=0x0002, May=0x0010.
        assert_eq!(months & 0x0080, 0x0080);
        assert_eq!(months & 0x0400, 0x0400);
        assert_eq!(months & 0x0002, 0x0002);
        assert_eq!(months & 0x0010, 0x0010);
        assert_eq!(months & 0x0001, 0); // January excluded
        assert_eq!(plan.day_of_month, Some(1 << 13)); // day 14
    }

    #[test]
    fn schedule_trigger_parts_rejects_invalid_start_datetimes() {
        assert!(schedule_trigger_parts(&ScheduleSpec::Daily {
            start_at: "not-a-datetime".to_string(),
        })
        .is_err());
        assert!(schedule_trigger_parts(&ScheduleSpec::Daily {
            start_at: "2026-08-14".to_string(),
        })
        .is_err());
        assert!(schedule_trigger_parts(&ScheduleSpec::Daily {
            start_at: "2026-08-14T25:30:00".to_string(),
        })
        .is_err());
        assert!(schedule_trigger_parts(&ScheduleSpec::Interval {
            start_at: "2026-13-40T08:30:00".to_string(),
            every: 30,
            unit: "minutes".to_string(),
        })
        .is_err());
    }

    #[test]
    fn create_task_spec_validates_arguments() {
        let spec = CreateTaskSpec {
            task_name: "PyscriptScheduler\\task-1".to_string(),
            venv_python_path: "C:\\Python312\\python.exe".to_string(),
            script_path: "C:\\Scripts\\backup.py".to_string(),
            arguments: vec!["--output".to_string(), "C:\\Backup Folder".to_string()],
            working_directory: "C:\\Scripts".to_string(),
            log_directory: "C:\\AppData\\logs".to_string(),
            schedule: ScheduleSpec::Daily {
                start_at: "2026-08-14T08:30:00".to_string(),
            },
        };
        // Validate without touching COM: each field individually.
        validate_text(&spec.task_name, "task_name").unwrap();
        validate_text(&spec.venv_python_path, "venv_python_path").unwrap();
        validate_text(&spec.script_path, "script_path").unwrap();
        validate_text(&spec.working_directory, "working_directory").unwrap();
        for argument in &spec.arguments {
            validate_text(argument, "argument").unwrap();
        }
        assert!(validate_text("bad&arg", "argument").is_err());
    }

    #[test]
    fn managed_task_names_filters_to_scripts_management_prefix() {
        let names = managed_task_names(vec![
            "PyscriptScheduler\\task-1".to_string(),
            "PyscriptScheduler\\task-2".to_string(),
            "\\PyscriptScheduler\\task-3".to_string(),
            "task-4".to_string(),
            "Other\\task".to_string(),
            "Windows\\Update".to_string(),
        ]);
        assert_eq!(
            names,
            vec![
                "PyscriptScheduler\\task-1".to_string(),
                "PyscriptScheduler\\task-2".to_string(),
                "PyscriptScheduler\\task-3".to_string(),
                // Bare names come from enumerating the PyscriptScheduler
                // subfolder; they must be normalized into the namespace.
                "PyscriptScheduler\\task-4".to_string(),
            ]
        );
        assert!(managed_task_names(vec![]).is_empty());
    }

    #[test]
    fn task_state_names_cover_all_known_states() {
        assert_eq!(task_state_name(TASK_STATE_UNKNOWN), "unknown");
        assert_eq!(task_state_name(TASK_STATE_DISABLED), "disabled");
        assert_eq!(task_state_name(TASK_STATE_QUEUED), "queued");
        assert_eq!(task_state_name(TASK_STATE_READY), "ready");
        assert_eq!(task_state_name(TASK_STATE_RUNNING), "running");
        assert_eq!(task_state_name(999), "unknown");
    }

    /// Real Task Scheduler integration: verifies `list_scheduled_tasks`
    /// enumerates tasks registered as `PyscriptScheduler\<id>` (which live
    /// in the PyscriptScheduler SUBFOLDER, not the root — the bug that made
    /// every task look missing). Gated `#[ignore]`; run with
    /// `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn list_scheduled_tasks_finds_tasks_in_managed_subfolder() {
        let task_name = "PyscriptScheduler\\p7-list-probe";
        let _ = delete_task(task_name); // clean any previous probe

        // A minimal Once task registered through the production COM path.
        let spec = CreateTaskSpec {
            task_name: task_name.to_string(),
            venv_python_path: "C:\\Windows\\System32\\cmd.exe".to_string(),
            script_path: "C:\\Windows\\System32\\cmd.exe".to_string(),
            arguments: vec![],
            working_directory: "C:\\Windows\\System32".to_string(),
            log_directory: std::env::temp_dir().to_string_lossy().to_string(),
            schedule: ScheduleSpec::Once {
                run_at: "2099-01-01T00:00:00".to_string(),
            },
        };
        create_task(&spec).unwrap();

        let names = list_scheduled_tasks().unwrap();
        assert!(
            names.iter().any(|name| name == task_name),
            "expected {} in {:?}",
            task_name,
            names
        );

        let _ = delete_task(task_name);
    }

    /// Real Task Scheduler integration: creates a task through the production
    /// COM path, verifies the battery setting is disabled (otherwise the task
    /// stays Queued forever on laptops running on battery), runs it, and
    /// asserts the redirected stdout log is actually written. Gated with
    /// `#[ignore]` because it registers and runs a real scheduled task; run
    /// explicitly with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn battery_task_executes_and_writes_stdout_log() {
        let task_name = "PyscriptScheduler\\p6-battery-probe";
        let log_dir = std::env::temp_dir().join("p6-battery-probe-logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let _ = delete_task(task_name); // clean any previous probe

        // A real python interpreter + a tiny script, mirroring production.
        let entries: Vec<String> = std::env::var("PATH")
            .unwrap_or_default()
            .split(';')
            .map(str::to_string)
            .collect();
        let python = crate::systeminfo::find_all_in_path("python", &entries)
            .into_iter()
            .next()
            .expect("python must be on PATH for this integration test");
        let script = log_dir.join("probe.py");
        std::fs::write(&script, "print('battery-probe-marker')\n").unwrap();

        let spec = CreateTaskSpec {
            task_name: task_name.to_string(),
            venv_python_path: python,
            script_path: script.to_string_lossy().to_string(),
            arguments: vec![],
            working_directory: log_dir.to_string_lossy().to_string(),
            log_directory: log_dir.to_string_lossy().to_string(),
            schedule: ScheduleSpec::Once {
                run_at: "2099-01-01T00:00:00".to_string(),
            },
        };
        create_task(&spec).unwrap();

        // The exported XML must not contain the battery-start restriction.
        let xml = std::process::Command::new("schtasks.exe")
            .args(["/Query", "/TN", task_name, "/XML"])
            .output()
            .unwrap();
        let xml_text = String::from_utf8_lossy(&xml.stdout).to_string();
        assert!(
            !xml_text.contains("DisallowStartIfOnBatteries>true"),
            "task must be allowed to start on battery, XML: {}",
            xml_text
        );

        // Running it must actually execute and write the stdout log.
        run_task(task_name).unwrap();
        let stem = log_file_stem(task_name);
        let stdout_log = log_dir.join(format!("{}.out.log", stem));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut content = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&stdout_log) {
                // cmd creates the redirect file empty before python writes,
                // so keep polling until the marker actually appears.
                if text.contains("battery-probe-marker") {
                    content = text;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        assert!(
            content.contains("battery-probe-marker"),
            "stdout log missing marker, content: {:?}",
            content
        );

        let _ = delete_task(task_name);
        let _ = std::fs::remove_dir_all(&log_dir);
    }
}
