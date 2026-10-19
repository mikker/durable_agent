require "socket"

# A one-thread HTTP server on a random port that answers with canned responses and records requests, so the
# real Net::HTTP client is exercised end to end.
#
#   FakeSidecar.serve("POST /conversations" => [ 201, { id: 7 } ]) do |sidecar|
#     DurableAgent::Client.new(url: sidecar.url, token: "t").create_conversation
#     sidecar.requests.first # => { method: "POST", path: "/conversations", headers: {...}, body: {...} }
#   end
class FakeSidecar
  attr_reader :requests

  def self.serve(routes)
    sidecar = new(routes)
    yield sidecar
  ensure
    sidecar&.stop
  end

  def initialize(routes)
    @routes, @requests = routes, []
    @server = TCPServer.new("127.0.0.1", 0)
    @thread = Thread.new { loop { respond(@server.accept) } }
  end

  def url = "http://127.0.0.1:#{@server.addr[1]}"

  def stop
    @thread.kill
    @server.close
  end

  private
    def respond(socket)
      method, path = socket.gets.split(" ")
      headers = {}
      while (line = socket.gets) && line != "\r\n"
        name, value = line.split(":", 2)
        headers[name.downcase] = value.strip
      end
      body = socket.read(headers["content-length"].to_i)
      @requests << { method: method, path: path, headers: headers, body: body.empty? ? nil : JSON.parse(body) }

      status, payload = @routes.fetch("#{method} #{path}") { [ 404, { error: "not found" } ] }
      json = payload.to_json
      socket.write "HTTP/1.1 #{status} X\r\nContent-Type: application/json\r\nContent-Length: #{json.bytesize}\r\nConnection: close\r\n\r\n#{json}"
    ensure
      socket.close
    end
end
