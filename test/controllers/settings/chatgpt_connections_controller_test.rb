require "test_helper"

class Settings::ChatgptConnectionsControllerTest < ActionDispatch::IntegrationTest
  PENDING = { "id" => "abc", "provider" => "openai", "status" => "awaiting_browser", "url" => "https://auth.openai.com/x", "messages" => [] }.freeze

  test "show when signed out offers sign-in" do
    stub_sidecar(auth: SidecarStubs::DISCONNECTED)
    get settings_chatgpt_connection_path
    assert_response :success
    assert_select "h1", "Settings"
    assert_select "form[action=?][method=post] button", settings_chatgpt_connection_path, text: "Sign in with ChatGPT"
  end

  test "show when connected names the running model and offers disconnect" do
    stub_sidecar(auth: SidecarStubs::CONNECTED, health: { "ok" => true, "model" => { "provider" => "openai", "modelId" => "gpt-6.1-sol" } })
    get settings_chatgpt_connection_path
    assert_select "[data-nk=badge]", /Connected with a ChatGPT subscription/
    assert_select "p", "The agent runs openai/gpt-6.1-sol."
    assert_select "form[action=?] input[name=_method][value=delete]", settings_chatgpt_connection_path
    assert_select "button", text: "Disconnect"
  end

  test "show says when the sidecar is unreachable" do
    stub_sidecar(auth: DurableAgent::Unavailable.new(nil, nil, "sidecar unreachable"))
    get settings_chatgpt_connection_path
    assert_response :success
    assert_select "[data-nk=alert]", /Agent sidecar unreachable/
    assert_select "button", text: "Sign in with ChatGPT", count: 0
  end

  test "show with a pending login links to sign-in, takes the pasted URL and refreshes" do
    stub_sidecar(auth: SidecarStubs::DISCONNECTED, login: PENDING)
    get settings_chatgpt_connection_path(login_id: "abc")
    assert_select "a[href='https://auth.openai.com/x']", text: "Open ChatGPT sign-in"
    assert_select "form[action=?] input[name=redirect_url][type=url]", settings_chatgpt_connection_path(login_id: "abc")
    assert_select "[data-controller=poll]"
    assert_select "[data-nk=badge]", "Awaiting browser"
  end

  test "show with a failed login explains the failure" do
    stub_sidecar(auth: SidecarStubs::DISCONNECTED, login: PENDING.merge("status" => "failed", "error" => "state mismatch"))
    get settings_chatgpt_connection_path(login_id: "abc")
    assert_select "[data-nk=alert]", /state mismatch/
  end

  test "show with an unknown login falls back to the plain page" do
    stub_sidecar(auth: SidecarStubs::DISCONNECTED, login: DurableAgent::Error.new(404, { "error" => "not found" }))
    get settings_chatgpt_connection_path(login_id: "gone")
    assert_redirected_to settings_chatgpt_connection_path
  end

  test "create starts a login and shows it" do
    stub_sidecar(start_login: PENDING)
    post settings_chatgpt_connection_path
    assert_redirected_to settings_chatgpt_connection_path(login_id: "abc")
  end

  test "update hands the pasted redirect URL to the sidecar" do
    stub_sidecar(complete_login: PENDING.merge("status" => "exchanging"))
    patch settings_chatgpt_connection_path(login_id: "abc"), params: { redirect_url: "http://localhost:1455/auth/callback?code=1" }
    assert_redirected_to settings_chatgpt_connection_path(login_id: "abc")
    assert_equal [ "openai", "abc", "http://localhost:1455/auth/callback?code=1" ], sidecar_calls(:complete_login).sole[1]
  end

  test "destroy signs out" do
    stub_sidecar(logout: { "ok" => true })
    delete settings_chatgpt_connection_path
    assert_redirected_to settings_chatgpt_connection_path
    assert_equal 1, sidecar_calls(:logout).size
  end
end
